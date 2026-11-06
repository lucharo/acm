// ── Editing-API audit: pure markup layer ──────────────────────────────────────
// Each test pins a defect found by the 2026-11 correctness audit of the editing
// API. They are `test.failing` so CI stays green while the bug exists: when a fix
// lands, the test starts PASSING its assertions, bun reports it as a failure, and
// the fixer flips `test.failing` → `test` in the same PR. Issue numbers in names.

import { describe, expect, test } from "bun:test";
import {
  addSuggestion,
  appendToThread,
  resolveSuggestion,
  resolveSuggestionGroup,
  resolveThread,
} from "../lib/agentEdits";
import {
  applyRangedEdits,
  formatComment,
  healDocument,
  scanTokens,
  suggestCards,
  suggestionThreadEdit,
  validateMarkup,
} from "../lib/criticmarkup";
import type { CommentToken } from "../lib/criticmarkup";

const kinds = (text: string) => validateMarkup(text).map((d) => d.kind);

describe("audit: wrapping a span", () => {
  test("#93 a span ending in `{` is refused or wrapped without creating a second `{==`", () => {
    const doc = "The set {a, b} is small.\n";
    let out: string | null = null;
    try {
      out = addSuggestion(doc, "set {", "claude", "pair {");
    } catch {
      out = null; // refusing the span is an acceptable fix
    }
    if (out !== null) {
      expect(kinds(out)).toEqual([]);
      expect(resolveSuggestion(out, "pair", "reject")).toBe(doc);
    }
    expect(out === null || suggestCards(out).length === 1).toBe(true);
  });

  test("#105 a group id the SUGGEST grammar can't parse is refused, not written as a dead card", () => {
    let out: string | null = null;
    try {
      out = addSuggestion("Alpha beta gamma.\n", "beta", "claude", "BETA", "mv 1");
    } catch {
      out = null;
    }
    expect(out === null || suggestCards(out).length === 1).toBe(true);
  });
});

describe("audit: accept / reject / resolve strip exactly their own markup", () => {
  test("#94 accept with discussion kept leaves balanced markup when the replacement holds `==}` or a blank line", () => {
    for (const repl of ["first para\n\nsecond para", "a ==} b"]) {
      let doc = addSuggestion("Alpha beta gamma.\n", "beta", "claude", repl);
      doc = appendToThread(doc, "SUGGEST", formatComment("luis", "hmm ok")).content;
      // A replacement holding a delimiter can't land as prose in any shape: flagging
      // the card and refusing the accept is a fix too (fail-safe on ambiguity).
      expect(kinds(doc).filter((k) => (k as string) !== "unsafe-suggestion")).toEqual([]);
      let out: string | null = null;
      try {
        out = resolveSuggestion(doc, "SUGGEST", "accept");
      } catch {
        out = null;
      }
      if (repl.includes("==}")) expect(out === null || kinds(out).length === 0).toBe(true);
      else expect(out !== null && kinds(out).length === 0).toBe(true);
    }
  });

  test("#95 resolving an inner thread keeps the enclosing highlight's `{==`", () => {
    const doc = "Para {=={==short==}{>>@a: inner note<<} and longer==}{>>@b: outer note<<} end.\n";
    expect(kinds(doc)).toEqual([]);
    expect(resolveThread(doc, "inner note")).toBe(
      "Para {==short and longer==}{>>@b: outer note<<} end.\n",
    );
  });

  test("#91 accepting a deletion card never re-anchors its leftover comments onto a neighbouring highlight", () => {
    const doc =
      "Keep {==this phrase==} {==very==}{>>@claude: SUGGEST:<<}{>>@gpt: SUGGEST: quite<<} important.\n";
    const del = scanTokens(doc).find(
      (t): t is CommentToken => t.type === "comment" && t.author === "claude",
    )!;
    const edit = suggestionThreadEdit(doc, del, "accept");
    expect(edit).not.toBeNull();
    const afterDelete = applyRangedEdits(doc, [edit!]);
    // The human's highlighted prose must survive any later verdict on the leftover card.
    let afterSecond = afterDelete;
    try {
      afterSecond = resolveSuggestion(afterDelete, "quite", "accept");
    } catch {
      /* refusing the orphaned alternative is fine */
    }
    expect(afterSecond).toContain("this phrase");
  });
});

describe("audit: suggestion groups", () => {
  test("#104 Apply all on a group with a member that lost its anchor refuses or reports it skipped", () => {
    const doc =
      "The {==universal mind==}{>>@claude: SUGGEST[g:um]: universal mind[^um]<<} idea.\n\n" +
      "[^a]: old def.{>>@claude: SUGGEST[g:um]: old def.\n[^um]: the def.<<}\n";
    let result: { applied: number; skipped: number } | "refused";
    try {
      const r = resolveSuggestionGroup(doc, "um", "accept");
      result = { applied: r.applied, skipped: r.skipped };
    } catch {
      result = "refused";
    }
    expect(result === "refused" || result.skipped === 1).toBe(true);
  });
});

describe("audit: CRLF documents", () => {
  test("#96 a highlight across a CRLF blank line is diagnosed like the LF one", () => {
    const lf = "First para {==starts here\n\nand ends here==}{>>@a: note<<}\n";
    const crlf = lf.replaceAll("\n", "\r\n");
    expect(kinds(lf).length).toBeGreaterThan(0); // control: LF is caught
    expect(kinds(crlf)).toEqual(kinds(lf));
  });

  test("#96 heal repairs a CRLF multi-block anchor and doesn't stall on later ones", () => {
    const doc = "A {==one\r\n\r\ntwo==}{>>@a: x<<}\n\nB {==three\n\nfour==}{>>@b: y<<}\n";
    expect(kinds(healDocument(doc))).toEqual([]);
  });
});

describe("audit: code is literal", () => {
  test("#97 heal leaves CriticMarkup inside a fenced code block untouched", () => {
    const doc = "Example:\n\n```\n{>>outer {>>inner<<} rest<<}\n```\n";
    expect(healDocument(doc)).toBe(doc);
  });
});
