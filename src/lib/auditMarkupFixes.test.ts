// Regression tests for the editing-API audit issues fixed in the markup layer.
// The audit's own repros live in src/audit/markupAudit.test.ts (PR #108); these
// pin the exact behaviour chosen here.

import { describe, expect, test } from "bun:test";

import { addSuggestion, appendToThread, resolveSuggestion, resolveSuggestionGroup, resolveThread } from "./agentEdits";
import {
  acceptedMarkdown,
  applyRangedEdits,
  formatComment,
  healDocument,
  scanTokens,
  suggestCards,
  suggestionGroupEdits,
  suggestionThreadEdit,
  validateMarkup,
  wrappableSpan,
} from "./criticmarkup";
import type { CommentToken } from "./criticmarkup";

const kinds = (doc: string) => validateMarkup(doc).map((d) => d.kind);

describe("#93 a span whose edge joins the wrap's delimiters is refused", () => {
  test("a span ending in `{` is not wrappable, so acm suggest refuses it", () => {
    const doc = "The set {a, b} is small.\n";

    expect(wrappableSpan(doc, 4, 9)).toBe(false);
    expect(() => addSuggestion(doc, "set {", "claude", "pair {")).toThrow("wrappable span");
  });

  test("an ordinary span and one wrapping a complete tracked change still wrap", () => {
    const doc = "a {++b++} c d";

    expect([wrappableSpan(doc, 0, 11), wrappableSpan(doc, 10, 11)]).toEqual([true, true]);
  });
});

describe("#94 accepting with replies keeps the markup balanced", () => {
  test("a multi-paragraph replacement keeps the replies as point comments after it", () => {
    let doc = addSuggestion("Alpha beta gamma.\n", "beta", "claude", "first para\n\nsecond para");
    doc = appendToThread(doc, "SUGGEST", formatComment("luis", "hmm ok")).content;

    const out = resolveSuggestion(doc, "SUGGEST", "accept");

    expect(out).toBe("Alpha first para\n\nsecond para{>>@luis: hmm ok<<} gamma.\n");
    expect(kinds(out)).toEqual([]);
  });

  test("a replacement holding a delimiter is flagged, has no Apply, and accept refuses", () => {
    let doc = addSuggestion("Alpha beta gamma.\n", "beta", "claude", "a ==} b");
    doc = appendToThread(doc, "SUGGEST", formatComment("luis", "hmm ok")).content;

    expect(kinds(doc)).toEqual(["unsafe-suggestion"]);
    expect(suggestCards(doc)).toEqual([]);
    expect(() => resolveSuggestion(doc, "SUGGEST", "accept")).toThrow("CriticMarkup delimiters");
    expect(resolveSuggestion(doc, "SUGGEST", "reject")).toBe("Alpha {==beta==}{>>@luis: hmm ok<<} gamma.\n");
  });
});

describe("#94 follow-ups: wrap check, literals, reject", () => {
  test("a replacement whose edge would join the wrap's delimiter keeps replies as point comments", () => {
    let doc = addSuggestion("Alpha beta gamma.\n", "beta", "claude", "pair {");
    doc = appendToThread(doc, "SUGGEST", formatComment("luis", "hmm ok")).content;

    const out = resolveSuggestion(doc, "SUGGEST", "accept");

    expect(out).toBe("Alpha pair {{>>@luis: hmm ok<<} gamma.\n");
    expect(kinds(out)).toEqual([]);
  });

  test("a replacement that is inline code holding a delimiter is safe to apply", () => {
    const doc = "Use {==this==}{>>@a: SUGGEST: `==}`<<} here.";

    expect(kinds(doc)).toEqual([]);
    expect(resolveSuggestion(doc, "SUGGEST", "accept")).toBe("Use `==}` here.");
  });

  test("a literal opener never pairs with a closer in prose", () => {
    expect(kinds("Use `{==` then ==} here")).toEqual(["stray-close"]);
  });

  test("an unsafe card can still be rejected, alone or as a group", () => {
    const doc = "A {==one==}{>>@a: SUGGEST[g:u]: a ==} b<<} and {==two==}{>>@a: SUGGEST[g:u]: deux<<}.";

    expect(applyRangedEdits(doc, suggestionGroupEdits(doc, "u", "reject").edits)).toBe("A one and two.");
    expect(() => resolveSuggestionGroup(doc, "u", "accept")).toThrow("1 member");
  });

  test("a SUGGEST example inside code is not a group member and never blocks the group", () => {
    const doc = "A {==one==}{>>@a: SUGGEST[g:g]: uno<<}.\n\n```\n{>>@a: SUGGEST[g:g]: example<<}\n```\n";

    expect(suggestionGroupEdits(doc, "g", "accept").unanchored).toBe(0);
    expect(resolveSuggestionGroup(doc, "g", "accept").content).toBe(
      "A uno.\n\n```\n{>>@a: SUGGEST[g:g]: example<<}\n```\n",
    );
  });
});

describe("a bare URL glued to markup ends at the markup", () => {
  test("an explicit link destination is never cut: markup inside it stays protected", () => {
    expect(acceptedMarkdown("[file](https://example.com/{++draft++}) x")).toEqual({
      ok: true,
      markdown: "[file](https://example.com/{++draft++}) x",
    });
  });

  test("a highlight crossing a fenced block still leaks, and is reported", () => {
    expect(kinds("{==before\n```\n\n```\nafter==}")).toEqual(["dangling-open", "stray-close"]);
  });

  test("the URL does not swallow the anchor's close and comment", () => {
    const doc = "see {==https://example.com/a==}{>>@a: SUGGEST: there<<} now";

    expect(kinds(doc)).toEqual([]);
    expect(resolveSuggestion(doc, "there", "accept")).toBe("see there now");
  });
});

describe("#95 resolve strips only its own anchor's opens", () => {
  test("an enclosing highlight that starts at the same word keeps its `{==`", () => {
    const doc = "Para {=={==short==}{>>@a: inner note<<} and longer==}{>>@b: outer note<<} end.\n";

    expect(resolveThread(doc, "inner note")).toBe("Para {==short and longer==}{>>@b: outer note<<} end.\n");
  });

  test("a genuine stacked same-anchor thread still flattens", () => {
    const doc = "x {=={==span==}{>>@a: c0<<}==}{>>@b: c1<<} y";

    expect(resolveThread(doc, "c0")).toBe("x span y");
  });
});

describe("#91 accepting a deletion takes competing alternatives with the span", () => {
  test("a competing SUGGEST is dropped, so it can't re-anchor on the neighbouring highlight", () => {
    const doc = "Keep {==this phrase==} {==very==}{>>@claude: SUGGEST:<<}{>>@gpt: SUGGEST: quite<<}{>>@luis: hmm<<} important.\n";
    const del = scanTokens(doc).find((t): t is CommentToken => t.type === "comment" && t.author === "claude")!;

    const out = applyRangedEdits(doc, [suggestionThreadEdit(doc, del, "accept")!]);

    expect(out).toBe("Keep {==this phrase==} {>>@luis: hmm<<} important.\n");
    expect(suggestCards(out)).toEqual([]);
  });
});

describe("#104 a group applies all or nothing", () => {
  const doc =
    "The {==universal mind==}{>>@claude: SUGGEST[g:um]: universal mind[^um]<<} idea.\n\n" +
    "[^a]: old def.{>>@claude: SUGGEST[g:um]: old def.\n[^um]: the def.<<}\n";

  test("a member without an anchor blocks the whole group and is reported", () => {
    expect(suggestionGroupEdits(doc, "um", "accept")).toEqual({ edits: [], skipped: 2, unanchored: 1 });
    expect(() => resolveSuggestionGroup(doc, "um", "accept")).toThrow("1 member has no anchored span");
  });
});

describe("#96 CRLF documents behave like their LF twins", () => {
  test("a highlight across a CRLF blank line is diagnosed and healed", () => {
    const lf = "First {==starts\n\nends==}{>>@a: note<<}\n";
    const crlf = lf.replaceAll("\n", "\r\n");

    expect(kinds(crlf)).toEqual(kinds(lf));
    expect(kinds(healDocument(crlf))).toEqual([]);
  });
});

describe("#97 code is literal", () => {
  test("heal and the validator leave CriticMarkup inside a fence alone", () => {
    const doc = "Example:\n\n```\n{>>outer {>>inner<<} rest<<}\n{==dangling\n```\n";

    expect(healDocument(doc)).toBe(doc);
    expect(validateMarkup(doc)).toEqual([]);
  });
});
