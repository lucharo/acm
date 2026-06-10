import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applySuggestion,
  applySuggestionToken,
  countWords,
  formatComment,
  groupCards,
  groupThreads,
  healNestedComments,
  healOneNestedComment,
  insertComment,
  nestedCommentIssues,
  resolveAnchorEdit,
  scanTokens,
  suggestionReplacement,
  applySuggestionEdit,
  rejectSuggestionEdit,
  inlineSuggestions,
  applicableSuggestionIds,
  validateMarkup,
  hardWrap,
  healDocument,
} from "./criticmarkup";
import { isComment, isSuggestion } from "./types";
import type { CommentToken, SubstituteToken, SuggestionToken } from "./types";

// ── scanTokens: each construct in isolation ───────────────────────────────────

describe("scanTokens — single constructs", () => {
  test("insertion {++ ++}", () => {
    const text = "a {++added++} b";
    const [t, ...rest] = scanTokens(text);
    expect(rest).toHaveLength(0);
    expect(t.type).toBe("insert");
    expect(t.raw).toBe("{++added++}");
    expect(t.from).toBe(2);
    expect(t.to).toBe(2 + "{++added++}".length);
    if (t.type === "insert") expect(t.inner).toBe("added");
  });

  test("deletion {-- --}", () => {
    const [t] = scanTokens("x {--gone--} y");
    expect(t.type).toBe("delete");
    expect(t.raw).toBe("{--gone--}");
    if (t.type === "delete") expect(t.inner).toBe("gone");
  });

  test("highlight {== ==}", () => {
    const [t] = scanTokens("see {==this==} here");
    expect(t.type).toBe("highlight");
    expect(t.raw).toBe("{==this==}");
    if (t.type === "highlight") expect(t.inner).toBe("this");
  });

  test("substitution {~~old~>new~~}", () => {
    const [t] = scanTokens("we {~~spend~>budget~~} it");
    expect(t.type).toBe("substitute");
    expect(t.raw).toBe("{~~spend~>budget~~}");
    if (t.type === "substitute") {
      expect(t.oldText).toBe("spend");
      expect(t.newText).toBe("budget");
    }
  });

  test("comment with @author prefix", () => {
    const [t] = scanTokens("anchor {>>@editor: needs a citation<<} tail");
    expect(t.type).toBe("comment");
    if (t.type === "comment") {
      expect(t.author).toBe("editor");
      expect(t.body).toBe("needs a citation");
    }
  });

  test("comment without prefix → author null", () => {
    const [t] = scanTokens("anchor {>>just a note<<}");
    expect(t.type).toBe("comment");
    if (t.type === "comment") {
      expect(t.author).toBeNull();
      expect(t.body).toBe("just a note");
    }
  });
});

// ── @author parsing edge cases ────────────────────────────────────────────────

describe("scanTokens — @author parsing", () => {
  test("author name with spaces", () => {
    const [t] = scanTokens("{>>@Jane Doe: looks fine<<}") as [CommentToken];
    expect(t.author).toBe("Jane Doe");
    expect(t.body).toBe("looks fine");
  });

  test("author trimmed and body trimmed", () => {
    const [t] = scanTokens("{>>  @claude :   spaced out   <<}") as [CommentToken];
    expect(t.author).toBe("claude");
    expect(t.body).toBe("spaced out");
  });

  test("@ without colon is NOT treated as author", () => {
    const [t] = scanTokens("{>>email me @handle for details<<}") as [CommentToken];
    expect(t.author).toBeNull();
    expect(t.body).toBe("email me @handle for details");
  });

  test("colon inside body after author keeps remainder intact", () => {
    const [t] = scanTokens("{>>@editor: note: this is fine<<}") as [CommentToken];
    expect(t.author).toBe("editor");
    expect(t.body).toBe("note: this is fine");
  });
});

// ── stacked comments (2 and 3 in a row) ───────────────────────────────────────

describe("scanTokens — stacked comments", () => {
  test("highlight followed by TWO comments — count, types, offsets, parse", () => {
    const text = "Attention is the {==scarcest resource==}{>>@editor: hedge it<<}{>>@claude: agree<<} today.";
    const tokens = scanTokens(text);
    expect(tokens).toHaveLength(3);

    expect(tokens[0].type).toBe("highlight");
    expect(tokens[1].type).toBe("comment");
    expect(tokens[2].type).toBe("comment");

    // Adjacent: each token starts exactly where the previous ended.
    expect(tokens[1].from).toBe(tokens[0].to);
    expect(tokens[2].from).toBe(tokens[1].to);

    const c1 = tokens[1] as CommentToken;
    const c2 = tokens[2] as CommentToken;
    expect(c1.author).toBe("editor");
    expect(c1.body).toBe("hedge it");
    expect(c2.author).toBe("claude");
    expect(c2.body).toBe("agree");

    // Unique, document-order ids.
    expect(new Set(tokens.map((t) => t.id)).size).toBe(3);
  });

  test("highlight followed by THREE comments", () => {
    const text =
      "{==deliberate cultivation of boredom==}{>>@luis: love it<<}{>>@editor: keep it<<}{>>@claude: compromise<<} end";
    const tokens = scanTokens(text);
    expect(tokens).toHaveLength(4);
    expect(tokens.map((t) => t.type)).toEqual(["highlight", "comment", "comment", "comment"]);

    const authors = tokens.filter(isComment).map((c) => c.author);
    expect(authors).toEqual(["luis", "editor", "claude"]);

    // None swallows the next: ranges are contiguous and non-overlapping.
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i].from).toBe(tokens[i - 1].to);
    }
  });
});

// ── adjacent constructs & delimiter chars in bodies ───────────────────────────

describe("scanTokens — adjacency & embedded delimiters", () => {
  test("adjacent constructs do not over-match", () => {
    const text = "{++a++}{--b--}{==c==}";
    const tokens = scanTokens(text);
    expect(tokens.map((t) => t.type)).toEqual(["insert", "delete", "highlight"]);
    expect(tokens[0].raw).toBe("{++a++}");
    expect(tokens[1].raw).toBe("{--b--}");
    expect(tokens[2].raw).toBe("{==c==}");
  });

  test("non-greedy: earliest close wins, body following text not absorbed", () => {
    // Two separate insertions, not one greedy `{++a++}...{++b++}`.
    const text = "{++a++} and then {++b++}";
    const tokens = scanTokens(text);
    expect(tokens).toHaveLength(2);
    expect((tokens[0] as { inner: string }).inner).toBe("a");
    expect((tokens[1] as { inner: string }).inner).toBe("b");
  });

  test("comment body containing >> does not break", () => {
    const [t] = scanTokens("{>>@a: use the >> operator carefully<<}") as [CommentToken];
    expect(t.author).toBe("a");
    expect(t.body).toBe("use the >> operator carefully");
  });

  test("substitution with arrow-like chars in text", () => {
    const [t] = scanTokens("{~~a > b~>c > d~~}") as [SubstituteToken];
    // First ~> is the separator; the `>` chars elsewhere stay in place.
    expect(t.oldText).toBe("a > b");
    expect(t.newText).toBe("c > d");
  });
});

// ── dangling / half-typed markup ──────────────────────────────────────────────

describe("scanTokens — dangling markup ignored", () => {
  test("unterminated insertion is not matched, no throw", () => {
    expect(scanTokens("text {++ half typed")).toEqual([]);
  });

  test("unterminated comment is not matched", () => {
    expect(scanTokens("a {>>@x: started but never closed")).toEqual([]);
  });

  test("dangling open then a valid construct later", () => {
    const tokens = scanTokens("{++ dangling, but here is {==real==}");
    // The dangling `{++` finds a close `==}` only if `++}` appears — it does not;
    // scanning continues and the highlight is matched.
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe("highlight");
    expect(tokens[0].raw).toBe("{==real==}");
  });

  test("lone braces produce no tokens", () => {
    expect(scanTokens("just { some } text")).toEqual([]);
  });
});

// ── formatComment ─────────────────────────────────────────────────────────────

describe("formatComment", () => {
  test("with author", () => {
    expect(formatComment("claude", "looks good")).toBe("{>>@claude: looks good<<}");
  });

  test("empty author omits the @prefix", () => {
    expect(formatComment("", "looks good")).toBe("{>>looks good<<}");
  });

  test("whitespace-only author treated as empty", () => {
    expect(formatComment("   ", "note")).toBe("{>>note<<}");
  });

  test("round-trips through scanTokens", () => {
    const raw = formatComment("editor", "a fine point");
    const [t] = scanTokens(raw) as [CommentToken];
    expect(t.raw).toBe(raw);
    expect(t.author).toBe("editor");
    expect(t.body).toBe("a fine point");
  });

  test("neutralizes a close marker hidden in the text", () => {
    const raw = formatComment("x", "do not break <<} this marker");
    const tokens = scanTokens(raw);
    // The literal `<<}` is neutralized, so the comment is a SINGLE token whose
    // raw spans the whole formatted string.
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe("comment");
    expect(tokens[0].raw).toBe(raw);
    expect(tokens[0].from).toBe(0);
    expect(tokens[0].to).toBe(raw.length);
  });
});

// ── insertComment ─────────────────────────────────────────────────────────────

describe("insertComment", () => {
  test("inserts a leading space when preceding char is non-space", () => {
    const out = insertComment("word", 4, "note", "luis");
    expect(out).toBe("word {>>@luis: note<<}");
  });

  test("no extra space when preceding char is whitespace", () => {
    const out = insertComment("word ", 5, "note", "luis");
    expect(out).toBe("word {>>@luis: note<<}");
  });

  test("no leading space at offset 0", () => {
    const out = insertComment("rest", 0, "note", "luis");
    expect(out).toBe("{>>@luis: note<<}rest");
  });

  test("clamps a negative offset to 0", () => {
    const out = insertComment("rest", -5, "note", "");
    expect(out).toBe("{>>note<<}rest");
  });

  test("clamps an over-large offset to length", () => {
    const out = insertComment("abc", 999, "note", "");
    expect(out).toBe("abc {>>note<<}");
  });

  test("inserted comment scans back as one comment token at the anchor", () => {
    const content = "Attention is the scarcest resource";
    const out = insertComment(content, content.length, "claude", "claude");
    const tokens = scanTokens(out);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe("comment");
  });
});

// ── applySuggestion — all six cases ───────────────────────────────────────────

describe("applySuggestion", () => {
  test("insertion accept keeps inner", () => {
    expect(applySuggestion("{++x++}", "accept")).toBe("x");
  });
  test("insertion reject drops it", () => {
    expect(applySuggestion("{++x++}", "reject")).toBe("");
  });
  test("deletion accept removes text", () => {
    expect(applySuggestion("{--x--}", "accept")).toBe("");
  });
  test("deletion reject keeps text", () => {
    expect(applySuggestion("{--x--}", "reject")).toBe("x");
  });
  test("substitution accept takes new", () => {
    expect(applySuggestion("{~~a~>b~~}", "accept")).toBe("b");
  });
  test("substitution reject keeps old", () => {
    expect(applySuggestion("{~~a~>b~~}", "reject")).toBe("a");
  });

  test("multi-word substitution from the seed", () => {
    expect(applySuggestion("{~~look at~>attend to~~}", "accept")).toBe("attend to");
    expect(applySuggestion("{~~look at~>attend to~~}", "reject")).toBe("look at");
  });

  test("throws on non-construct raw", () => {
    expect(() => applySuggestion("not markup", "accept")).toThrow();
  });

  test("throws when raw has trailing junk past the construct", () => {
    expect(() => applySuggestion("{++x++} extra", "accept")).toThrow();
  });
});

// ── applySuggestionToken delegates to applySuggestion ─────────────────────────

describe("applySuggestionToken", () => {
  test("matches applySuggestion(token.raw, mode) for every suggestion in the seed-like text", () => {
    const text = "we {~~spend~>budget~~} {++always++} the {--obvious--} thing";
    const suggestions = scanTokens(text).filter(isSuggestion) as SuggestionToken[];
    expect(suggestions).toHaveLength(3);
    for (const t of suggestions) {
      expect(applySuggestionToken(t, "accept")).toBe(applySuggestion(t.raw, "accept"));
      expect(applySuggestionToken(t, "reject")).toBe(applySuggestion(t.raw, "reject"));
    }
  });
});

// ── invariant: text.slice(from, to) === raw, incl. the real seed document ─────

describe("invariant — raw matches the sliced span", () => {
  test("synthetic mixed document", () => {
    const text =
      "A {==hl==}{>>@a: c1<<}{>>@b: c2<<} mid {++ins++} {--del--} {~~o~>n~~} end {>>plain<<}";
    const tokens = scanTokens(text);
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect(text.slice(t.from, t.to)).toBe(t.raw);
    }
    // ids unique.
    expect(new Set(tokens.map((t) => t.id)).size).toBe(tokens.length);
    // non-overlapping, sorted by from.
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i].from).toBeGreaterThanOrEqual(tokens[i - 1].to);
    }
  });

  test("the live seed document — sample-essay.md (133 comments)", () => {
    const path = join(import.meta.dir, "..", "..", "seed", "sample-essay.md");
    const content = readFileSync(path, "utf8");
    const tokens = scanTokens(content);

    // The real Sample doc carries ≥133 comments (agents may add review replies
    // live, so this is a floor, not an exact count), plus highlights and tracked
    // changes. Assert the essential constructs are present and every type is valid
    // — without pinning an exact mix the converter/agents can shift.
    const types = new Set(tokens.map((t) => t.type));
    const VALID = new Set(["insert", "delete", "substitute", "highlight", "comment"]);
    for (const t of types) expect(VALID.has(t)).toBe(true);
    expect(types.has("comment")).toBe(true);
    expect(types.has("highlight")).toBe(true);
    expect(tokens.filter(isComment).length).toBeGreaterThanOrEqual(133);

    // Raw-slice invariant holds for every token (the scanner never mis-bounds a
    // construct, even amid the doc's stacked/nested highlights).
    for (const t of tokens) {
      expect(content.slice(t.from, t.to)).toBe(t.raw);
    }

    // ids unique across the whole document.
    expect(new Set(tokens.map((t) => t.id)).size).toBe(tokens.length);

    // Every suggestion's accept/reject yields a plain string (no throw).
    for (const t of tokens.filter(isSuggestion) as SuggestionToken[]) {
      expect(typeof applySuggestionToken(t, "accept")).toBe("string");
      expect(typeof applySuggestionToken(t, "reject")).toBe("string");
    }
  });

  test("token ids are content-derived — stable across unrelated edits (#19)", () => {
    const before = "a {==x==}{>>@l: one<<} b {++mid++} c {>>@m: two<<} d";
    // Remove the FIRST construct pair; every other token's id must survive.
    const after = "a x b {++mid++} c {>>@m: two<<} d";
    const idsBefore = new Map(scanTokens(before).map((t) => [t.raw, t.id]));
    for (const t of scanTokens(after)) {
      expect(t.id).toBe(idsBefore.get(t.raw)!);
    }
    // Byte-identical duplicates still get distinct ids.
    const dup = scanTokens("x {++same++} y {++same++} z");
    expect(dup).toHaveLength(2);
    expect(dup[0].id).not.toBe(dup[1].id);
  });
});

// ── no-swallow / single-block guards (review hardening) ───────────────────────

describe("scanTokens — no-swallow guard", () => {
  test("a stray unclosed open does NOT swallow a later same-type construct", () => {
    // The first `{--` has no close of its own; without the guard it would consume
    // up to the real deletion's close, swallowing the prose between (and, on accept,
    // deleting it). The guard makes it bail so only the real {--remove--} matches.
    const text = "Here a {-- stray marker. Later a real {--remove--} suggestion.";
    const tokens = scanTokens(text);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe("delete");
    expect(tokens[0].raw).toBe("{--remove--}");
    expect(text.slice(tokens[0].from, tokens[0].to)).toBe("{--remove--}");
  });

  test("a stray {>> does not swallow a later real comment", () => {
    const text = "Note {>> half-typed and then a {>>@claude: real one<<} after.";
    const tokens = scanTokens(text);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe("comment");
    expect((tokens[0] as CommentToken).author).toBe("claude");
    expect((tokens[0] as CommentToken).body).toBe("real one");
  });

  test("a construct body may not cross a blank line (single-block)", () => {
    // Matches the editor's block-bounded lezer parser: a close on the far side of a
    // paragraph break is not a valid close, so the construct is left as plain text.
    const text = "para one {>>@a: note\n\nstill going<<} para two";
    expect(scanTokens(text)).toHaveLength(0);
    // A single newline (same block) is fine.
    const ok = scanTokens("line {>>@a: note\nstill same block<<} end");
    expect(ok).toHaveLength(1);
    expect(ok[0].type).toBe("comment");
  });

  test("arrowless {~~ ~~} is not a substitution token (agrees with the editor)", () => {
    expect(scanTokens("a {~~justold~~} b")).toHaveLength(0);
    const ok = scanTokens("a {~~old~>new~~} b") as SubstituteToken[];
    expect(ok).toHaveLength(1);
    expect(ok[0].type).toBe("substitute");
    expect(ok[0].oldText).toBe("old");
    expect(ok[0].newText).toBe("new");
  });

  test("a lone { (not a construct open) does not abort matching", () => {
    const text = "math {x} aside {++added++} done";
    const tokens = scanTokens(text);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe("{++added++}");
  });
});

// ── nesting-aware highlights (anchors wrapping tracked changes) ───────────────
// The editor's lezer grammar treats `{==`/`==}` as paired delimiters, so a
// highlight can WRAP tracked changes — the GDocs converter and agent suggestions
// both produce `{==a {++b++} c==}{>>…<<}`. scanTokens must agree, or the editor
// renders an anchor the lib can't see and any SUGGEST on it is dead.

describe("scanTokens — highlight wrapping tracked changes", () => {
  const text =
    "The {==span with {++inserted++} and {--deleted--} bits==}{>>@claude: SUGGEST: span with mixed edits<<} is complex.";

  test("emits the anchor highlight AND the contained tracked changes", () => {
    const tokens = scanTokens(text);
    expect(tokens.map((t) => t.type)).toEqual(["highlight", "insert", "delete", "comment"]);
    const [hl, ins, del] = tokens;
    expect(hl.raw).toBe("{==span with {++inserted++} and {--deleted--} bits==}");
    if (hl.type === "highlight")
      expect(hl.inner).toBe("span with {++inserted++} and {--deleted--} bits");
    // Containment: the tracked changes live INSIDE the highlight's range.
    expect(ins.from).toBeGreaterThan(hl.from);
    expect(del.to).toBeLessThan(hl.to);
    // Raw-slice invariant still holds for every token.
    for (const t of tokens) expect(text.slice(t.from, t.to)).toBe(t.raw);
  });

  test("a SUGGEST on such an anchor is applyable (inline + sidebar agree)", () => {
    const sugs = inlineSuggestions(text);
    expect(sugs).toHaveLength(1);
    expect(sugs[0].replacement).toBe("span with mixed edits");
    expect(applicableSuggestionIds(text).has(sugs[0].commentId)).toBe(true);
  });

  test("accept replaces the whole span; reject keeps it verbatim (pending edits intact)", () => {
    const comment = scanTokens(text).find(isComment) as CommentToken;
    expect(applySuggestionEdit(text, comment)).toEqual({
      from: 4,
      to: 102,
      insert: "span with mixed edits",
    });
    expect(rejectSuggestionEdit(text, comment)).toEqual({
      from: 4,
      to: 102,
      insert: "span with {++inserted++} and {--deleted--} bits",
    });
  });

  test("a `==}` inside a nested construct body cannot close the highlight early", () => {
    const tricky = "x {==a {++b==}c++} d==} y";
    const tokens = scanTokens(tricky);
    expect(tokens.map((t) => t.type)).toEqual(["highlight", "insert"]);
    expect(tokens[0].raw).toBe("{==a {++b==}c++} d==}");
    expect((tokens[1] as { inner: string }).inner).toBe("b==}c");
  });

  test("a half-typed nested open is literal text, the highlight still closes", () => {
    const tokens = scanTokens("x {==a {++half b==} y");
    expect(tokens.map((t) => t.type)).toEqual(["highlight"]);
    if (tokens[0].type === "highlight") expect(tokens[0].inner).toBe("a {++half b");
  });

  test("nested {== or {>> keeps the flat stacked-thread model (outer unparsed)", () => {
    // Stacked GDocs thread: inner highlight + comments tokenize; outer is gap noise.
    const stacked = "lead {=={==span==}{>>@a: parent<<}==}{>>@b: reply<<} tail";
    expect(scanTokens(stacked).map((t) => t.type)).toEqual(["highlight", "comment", "comment"]);
  });

  test("a stray {== never swallows a later real anchor", () => {
    const tokens = scanTokens("stray {== text. Later {==real==}{>>@c: x<<} end");
    expect(tokens.map((t) => t.raw)).toEqual(["{==real==}", "{>>@c: x<<}"]);
  });

  test("highlight body still cannot cross a blank line", () => {
    const tokens = scanTokens("{==spans a {++x++} break\n\nand on==} y");
    // The highlight is unparsed (single-block); only the inner insert tokenizes.
    expect(tokens.map((t) => t.type)).toEqual(["insert"]);
  });
});

// ── healDocument — in-place repair of converter-era leaks ─────────────────────

describe("healDocument", () => {
  test("a multi-block anchor re-anchors on its final block; earlier paragraphs stay prose", () => {
    const doc = "{==First para of the span.\n\nSecond para. ==}{>>@l: note<<} tail";
    const healed = healDocument(doc);
    expect(healed).toBe("First para of the span.\n\n{==Second para. ==}{>>@l: note<<} tail");
    expect(validateMarkup(healed)).toEqual([]);
  });

  test("the stacked multi-block form converges to a canonical stacked thread", () => {
    // The exact shape from the live doc: {=={==A…\\n\\n> B ==}{>>a<<}==}{>>b<<}
    const doc = "x {=={==A one.\n\n> B two. ==}{>>@l: a<<}==}{>>@l: b<<} y";
    const healed = healDocument(doc);
    expect(healed).toBe("x A one.\n\n> {=={==B two. ==}{>>@l: a<<}==}{>>@l: b<<} y");
    expect(validateMarkup(healed)).toEqual([]);
    // …and it threads as ONE two-message conversation on the final block.
    const comments = scanTokens(healed).filter(isComment);
    expect(groupThreads(comments, healed)).toHaveLength(1);
  });

  test("the relocated open lands AFTER a list/heading line prefix", () => {
    const doc = "{==spans into\n\n- a list item ==}{>>@l: n<<} end";
    const healed = healDocument(doc);
    expect(healed).toBe("spans into\n\n- {==a list item ==}{>>@l: n<<} end");
  });

  test("comments trapped inside a tracked change move out (and thread onto it)", () => {
    const doc = "{++{>>@l: c1<<}{>>@l: c2<<}Jane ++}Doe talks";
    const healed = healDocument(doc);
    expect(healed).toBe("{++Jane ++}{>>@l: c1<<}{>>@l: c2<<}Doe talks");
    expect(validateMarkup(healed)).toEqual([]);
  });

  test("cross-construct interleaves are left alone (healing would corrupt)", () => {
    // Healing the insert here would let it swallow the highlight's close.
    const doc = "{==a {++==}{>>@l: c<<}b++} tail";
    expect(healDocument(doc)).toBe(doc);
  });

  test("the seed doc: 22 diagnostics → 4 (only interleaves remain), nothing lost", () => {
    const path = join(import.meta.dir, "..", "..", "seed", "sample-essay.md");
    const content = readFileSync(path, "utf8");
    const healed = healDocument(content);
    expect(validateMarkup(content)).toHaveLength(22);
    expect(validateMarkup(healed)).toHaveLength(4);
    expect(scanTokens(healed).filter(isComment)).toHaveLength(133);
    expect(countWords(healed)).toBe(countWords(content));
    expect(healDocument(healed)).toBe(healed); // idempotent
  });
});

// ── hardWrap (#10) — markup-safe prose reflow ──────────────────────────────────

describe("hardWrap", () => {
  test("a long paragraph refills to the width; structure lines stay verbatim", () => {
    const text = [
      "# Heading stays",
      "",
      "word ".repeat(40).trim(), // 199 chars of prose
      "",
      "> a blockquote line that is quite long and must not be touched by the wrapper at all",
      "- a list item that is also long enough to exceed the width but must stay verbatim too",
      "```",
      "code line that is long                                              and spacing-sensitive",
      "```",
    ].join("\n");
    const wrapped = hardWrap(text, 40);
    const lines = wrapped.split("\n");
    expect(lines[0]).toBe("# Heading stays");
    // The prose paragraph wrapped to ≤40 cols…
    const prose = lines.filter((l) => l.startsWith("word"));
    expect(prose.length).toBeGreaterThan(1);
    for (const l of prose) expect(l.length).toBeLessThanOrEqual(40);
    // …while quote/list/code survive byte-identical.
    expect(wrapped).toContain("> a blockquote line that is quite long and must not be touched by the wrapper at all");
    expect(wrapped).toContain("- a list item that is also long enough to exceed the width but must stay verbatim too");
    expect(wrapped).toContain("code line that is long                                              and spacing-sensitive");
  });

  test("CriticMarkup constructs are atomic: raws byte-identical, ids stable, adjacency kept", () => {
    const text =
      "Lead-in prose that runs long enough to need wrapping at a narrow width, then " +
      "{==an anchored span==}{>>@l: with a fairly long comment body attached to it<<} and " +
      "a {++tracked insertion++} plus more trailing prose to push past the limit again.";
    const wrapped = hardWrap(text, 48);
    const before = scanTokens(text);
    const after = scanTokens(wrapped);
    expect(after.map((t) => t.raw)).toEqual(before.map((t) => t.raw));
    expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
    // The anchor and its comment stay ADJACENT (no space injected between atoms).
    expect(wrapped).toContain("{==an anchored span==}{>>@l:");
  });

  test("idempotent, and word count is invariant", () => {
    const text = "Some prose with {==a span==}{>>@a: note<<} and {++an insert++} that wraps around the chosen width.";
    const once = hardWrap(text, 30);
    expect(hardWrap(once, 30)).toBe(once);
    expect(countWords(once)).toBe(countWords(text));
  });

  test("the seed doc round-trips: same tokens, same word count, idempotent", () => {
    const path = join(import.meta.dir, "..", "..", "seed", "sample-essay.md");
    const content = readFileSync(path, "utf8");
    const wrapped = hardWrap(content, 88);
    expect(scanTokens(wrapped).map((t) => t.raw)).toEqual(scanTokens(content).map((t) => t.raw));
    expect(countWords(wrapped)).toBe(countWords(content));
    expect(hardWrap(wrapped, 88)).toBe(wrapped);
  });
});

// ── validateMarkup (#18) — positioned diagnostics for everything that leaks ───

describe("validateMarkup", () => {
  test("clean documents produce ZERO diagnostics (incl. stacked threads + wrapped anchors)", () => {
    const clean = [
      "plain prose, no markup at all",
      "a {==x==}{>>@l: note<<} b {++ins++} c {--del--} d {~~o~>n~~} e",
      "stacked {=={==x==}{>>@a: p<<}==}{>>@b: r<<} thread",
      "wrapped {==a {++b++} and {--c--} d==}{>>@x: SUGGEST: e<<} anchor",
      "gap {==x==} {>>@l: spaced<<} tolerance",
      "a {x} brace and a ~> arrow in prose",
    ];
    for (const c of clean) expect(validateMarkup(c)).toEqual([]);
  });

  test("dangling opens and stray closes are flagged at the delimiter", () => {
    const d1 = validateMarkup("a {++ never closed");
    expect(d1).toHaveLength(1);
    expect(d1[0].kind).toBe("dangling-open");
    expect(d1[0].from).toBe(2);

    const d2 = validateMarkup("orphan ++} here and ==} there");
    expect(d2.map((d) => d.kind)).toEqual(["stray-close", "stray-close"]);
  });

  test("a multi-paragraph highlight leaks: open flagged at the break, close flagged stray", () => {
    const d = validateMarkup("{==spans\n\nparagraphs==} end");
    expect(d.map((x) => x.kind)).toEqual(["dangling-open", "stray-close"]);
    expect(d[0].from).toBe(0); // the {==
  });

  test("nested comment flagged once, aligned with the heal flow", () => {
    const text = "host {>>@a: outer {>>@b: inner<<} more<<} tail";
    const d = validateMarkup(text);
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe("nested-comment");
    expect(d[0].from).toBe(nestedCommentIssues(text)[0].from);
  });

  test("arrowless substitution: ONE diagnostic, close not double-flagged", () => {
    const d = validateMarkup("a {~~just old~~} b");
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe("unparsed");
  });

  test("a comment body containing markup delimiters is flagged (it won't parse)", () => {
    const d = validateMarkup("note {>>@a: see {++this++} bit<<} end");
    // The comment open leaks; the inner insert parses on its own; the comment's
    // orphaned <<} is flagged stray.
    expect(d.map((x) => x.kind)).toEqual(["unparsed", "stray-close"]);
  });

  test("the seed doc's known leaks are all caught (warning no longer undercounts)", () => {
    const path = join(import.meta.dir, "..", "..", "seed", "sample-essay.md");
    const content = readFileSync(path, "utf8");
    const d = validateMarkup(content);
    // ~6 multi-paragraph anchors + 2 comments nested inside insertions (+ their
    // orphaned closes). Pin the observed count so a parser change that silently
    // alters leak detection fails loudly.
    expect(d).toHaveLength(22);
    expect(d.filter((x) => x.kind === "dangling-open")).toHaveLength(8);
    // Every diagnostic points at a real delimiter.
    for (const x of d) {
      expect(["{++", "{--", "{~~", "{==", "{>>", "++}", "--}", "~~}", "==}", "<<}"]).toContain(
        content.slice(x.from, x.to),
      );
    }
  });
});

describe("groupThreads", () => {
  test("adjacent comments form one thread; spaced-out ones stay separate", () => {
    const text = "x {>>@a: one<<}{>>@b: two<<} y {>>@c: far<<} z";
    const comments = scanTokens(text).filter(isComment) as CommentToken[];
    const threads = groupThreads(comments, text);
    expect(threads).toHaveLength(2);
    expect(threads[0].comments.map((c) => c.author)).toEqual(["a", "b"]);
    expect(threads[1].comments.map((c) => c.author)).toEqual(["c"]);
    // Thread span covers the whole adjacent run (replies append at `to`).
    expect(threads[0].from).toBe(comments[0].from);
    expect(threads[0].to).toBe(comments[1].to);
  });

  test("nested-highlight stack groups despite the orphaned ==} between siblings", () => {
    // Google Docs encodes same-anchor replies as NESTED highlights — siblings are
    // separated by the orphaned highlight close `==}`, not whitespace. They must
    // still group into ONE thread (parent first, then the reply).
    const text = "lead {=={==span==}{>>@a: parent<<}==}{>>@b: reply<<} tail";
    const comments = scanTokens(text).filter(isComment) as CommentToken[];
    const threads = groupThreads(comments, text);
    expect(threads).toHaveLength(1);
    expect(threads[0].comments.map((c) => c.author)).toEqual(["a", "b"]);
  });

  test("the seed's stacked anchors thread correctly (32 spans, deepest 5)", () => {
    const path = join(import.meta.dir, "..", "..", "seed", "sample-essay.md");
    const content = readFileSync(path, "utf8");
    const comments = scanTokens(content).filter(isComment) as CommentToken[];
    const threads = groupThreads(comments, content);

    // Every comment lands in exactly one thread.
    expect(threads.reduce((n, t) => n + t.comments.length, 0)).toBe(133);

    // The very first sentence ("Attention might be our most valuable resource…")
    // is a 2-comment thread — the documented smoke test.
    expect(threads[0].comments).toHaveLength(2);

    // The deepest thread is 5 comments on one sentence.
    const lengths = threads.map((t) => t.comments.length);
    expect(Math.max(...lengths)).toBe(5);

    // The doc has ~32 anchor spans carrying 2+ comments. Span-based grouping
    // recovers at least 31 of them as threads; one reply was re-anchored by the
    // converter across a paragraph break (into an insertion), so it can't be
    // merged by span containment — hence the floor rather than an exact 32.
    const multi = threads.filter((t) => t.comments.length >= 2);
    expect(multi.length).toBeGreaterThanOrEqual(31);
  });
});

describe("countWords", () => {
  test("plain prose", () => {
    expect(countWords("one two three four")).toBe(4);
  });
  test("comments and deletions don't count; insertions, sub-new, highlights do", () => {
    // prose: "keep this" (2) + insertion "added" (1) + highlight "hot" (1) + sub-new "new" (1) = 5
    const text = "keep this {>>@a: ignore me<<} {--gone--} {++added++} {==hot==} {~~old~>new~~}";
    expect(countWords(text)).toBe(5);
  });
  test("nested stacked-thread highlights don't leak delimiters into the count", () => {
    // "Attention" (1) + reply/comment bodies excluded → just the span words.
    const text = "{=={==Attention is scarce==}{>>@a: hmm<<}==}{>>@b: agree<<}";
    expect(countWords(text)).toBe(3); // Attention is scarce
  });
  test("markdown markers are not counted as words", () => {
    // → "Title bold and em and code here" = 7 words (markers #, **, _, ` stripped)
    expect(countWords("# Title\n\n**bold** and _em_ and `code` here")).toBe(7);
  });
});

describe("resolveAnchorEdit — resolving strips the whole anchor, keeps the span", () => {
  const apply = (text: string, from: number, to: number) => {
    const e = resolveAnchorEdit(text, from, to);
    return text.slice(0, e.from) + e.insert + text.slice(e.to);
  };
  test("simple anchored comment → span kept, highlight + comment gone", () => {
    const text = "see {==this span==}{>>@a: note<<} ok";
    const c = scanTokens(text).filter(isComment) as CommentToken[];
    expect(apply(text, c[0].from, c[0].to)).toBe("see this span ok");
  });
  test("stacked thread → whole nest stripped, no orphaned {==", () => {
    const text = "x {=={==the span==}{>>@a: one<<}==}{>>@b: two<<} y";
    const c = scanTokens(text).filter(isComment) as CommentToken[];
    const t = groupThreads(c, text)[0];
    const out = apply(text, t.from, t.to);
    expect(out).toBe("x the span y");
    expect(out).not.toContain("{=="); // no leaked delimiter
  });
  test("point comment (no highlight anchor) → just removed", () => {
    const text = "hello {>>@a: aside<<} world";
    const c = scanTokens(text).filter(isComment) as CommentToken[];
    expect(apply(text, c[0].from, c[0].to)).toBe("hello  world");
  });
});

describe("nested-comment heal + insert clamp (the comment-in-comment bug)", () => {
  test("clampAnchorOutsideComments pushes an inside-a-comment anchor to after it", () => {
    const text = "word {>>@a: existing<<} tail";
    const inside = text.indexOf("existing");
    const out = insertComment(text, inside, "new", "b");
    expect(/\{>>[^<]*\{>>/.test(out)).toBe(false); // no nesting created
    expect(out).toContain("{>>@b: new<<}");
    expect(scanTokens(out).filter(isComment)).toHaveLength(2);
  });
  test("healNestedComments flattens a nested comment + rejoins the split word", () => {
    const text = "x {>>@a: keep the YouTube-co{>>@b: aside<<}nflict<<} y";
    // The pulled-out comment is space-separated (standalone card), NOT adjacent
    // (which would wrongly thread it with the host).
    expect(healNestedComments(text)).toBe(
      "x {>>@a: keep the YouTube-conflict<<} {>>@b: aside<<} y",
    );
    expect(nestedCommentIssues(healNestedComments(text))).toHaveLength(0);
  });
  test("healNestedComments recurses (doubly nested) and keeps every comment", () => {
    const text = "{>>@a: A{>>@b: B{>>@c: C<<}D<<}E<<}";
    const healed = healNestedComments(text);
    expect(nestedCommentIssues(healed)).toHaveLength(0);
    expect((healed.match(/\{>>/g) ?? []).length).toBe(3);
  });
  test("a clean document is left unchanged", () => {
    const text = "a {>>@a: one<<}{>>@b: two<<} mid {==hl==}{>>@c: note<<} end";
    expect(healNestedComments(text)).toBe(text);
    expect(nestedCommentIssues(text)).toHaveLength(0);
  });
  test("healOneNestedComment heals only the issue at the given offset", () => {
    // Two independent nested comments; healing the FIRST leaves the second intact.
    const a = "{>>@a: keep YouTube-co{>>@b: aside<<}nflict<<} mid {>>@c: psych{>>@d: ref<<}iatric<<}";
    const firstFrom = a.indexOf("{>>@a");
    const healed = healOneNestedComment(a, firstFrom)!;
    expect(healed).toBe("{>>@a: keep YouTube-conflict<<} {>>@b: aside<<} mid {>>@c: psych{>>@d: ref<<}iatric<<}");
    // The second issue is untouched (still 1 nested issue remaining).
    expect(nestedCommentIssues(healed)).toHaveLength(1);
  });
  test("healOneNestedComment returns null when there's nothing nested at the offset", () => {
    const text = "{>>@a: clean comment<<} tail";
    expect(healOneNestedComment(text, 0)).toBeNull();
    expect(healOneNestedComment(text, 5)).toBeNull(); // not a {>> start
  });
});

describe("groupCards — suggestions + comment threads as one ordered set", () => {
  test("a suggestion claims an adjacent comment as a reply", () => {
    const text = "Body {~~old~>new~~}{>>@a: why?<<} more {==hl==}{>>@b: note<<} end";
    const cards = groupCards(scanTokens(text), text);
    expect(cards).toHaveLength(2);
    // ordered by `from`: the substitution card first, then the highlight-anchored comment.
    expect(cards[0].kind).toBe("suggestion");
    expect(cards[0].comments.map((c) => c.body)).toEqual(["why?"]);
    expect(cards[1].kind).toBe("comment");
    expect(cards[1].comments.map((c) => c.body)).toEqual(["note"]);
  });
  test("a suggestion does NOT claim a comment separated by a real highlight", () => {
    const text = "x {++ins++}{==hl==}{>>@a: about hl<<} y";
    const cards = groupCards(scanTokens(text), text);
    const sug = cards.find((c) => c.kind === "suggestion")!;
    expect(sug.comments).toHaveLength(0); // the comment belongs to the highlight, not the insert
    const com = cards.find((c) => c.kind === "comment")!;
    expect(com.comments.map((c) => c.body)).toEqual(["about hl"]);
  });
  test("a bare suggestion with no comment is still a card", () => {
    const cards = groupCards(scanTokens("a {--gone--} b"), "a {--gone--} b");
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("suggestion");
    expect(cards[0].comments).toHaveLength(0);
  });
});

describe("structured suggestions (SUGGEST: …)", () => {
  test("suggestionReplacement parses the body, ignores plain comments", () => {
    expect(suggestionReplacement("SUGGEST: the new wording")).toBe("the new wording");
    expect(suggestionReplacement("SUGGEST:no space")).toBe("no space");
    expect(suggestionReplacement("SUGGEST: ")).toBe(""); // suggest deleting the span
    expect(suggestionReplacement("just a normal comment")).toBeNull();
    expect(suggestionReplacement("please suggest an edit")).toBeNull(); // not a directive
  });
  test("applySuggestionEdit replaces the anchored span + the comment with the replacement", () => {
    const text = 'Pay {==implies a sacrifice, a cost you cannot get back==}{>>@claude: SUGGEST: implies a cost you don’t get back<<} here.';
    const sug = scanTokens(text).find((t) => t.type === "comment") as CommentToken;
    const edit = applySuggestionEdit(text, sug)!;
    const out = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
    expect(out).toBe("Pay implies a cost you don’t get back here.");
  });
  test("suggestionThreadEdit flattens a stacked anchor and keeps sibling discussion", () => {
    const text = "x {=={==old span==}{>>@a: SUGGEST: new span<<}==}{>>@b: keep talking<<} y";
    const a = scanTokens(text)
      .filter((t): t is CommentToken => t.type === "comment")
      .find((c) => c.body.includes("new span"))!;
    const acc = applySuggestionEdit(text, a)!;
    const out = text.slice(0, acc.from) + acc.insert + text.slice(acc.to);
    // span edited, stacked wrapper flattened, @b discussion preserved on the new span.
    expect(out).toBe("x {==new span==}{>>@b: keep talking<<} y");
  });
  test("applySuggestionEdit returns null for a non-suggestion or unanchored comment", () => {
    const plain = scanTokens("{==span==}{>>@a: just a note<<}").find((t) => t.type === "comment") as CommentToken;
    expect(applySuggestionEdit("{==span==}{>>@a: just a note<<}", plain)).toBeNull();
    const pt = scanTokens("text {>>@a: SUGGEST: x<<}").find((t) => t.type === "comment") as CommentToken;
    expect(applySuggestionEdit("text {>>@a: SUGGEST: x<<}", pt)).toBeNull(); // no highlight anchor
  });
  test("applySuggestionEdit tolerates THREAD_GAP between highlight and comment (a stray space)", () => {
    // The emitter writes them zero-gap, but a stray space must NOT silently dead-click:
    // the anchor lookup uses the same adjacency rule as threading.
    const text = "Pay {==old span==} {>>@a: SUGGEST: new span<<} here.";
    const sug = scanTokens(text).find((t) => t.type === "comment") as CommentToken;
    const edit = applySuggestionEdit(text, sug)!;
    const out = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
    expect(out).toBe("Pay new span here."); // gap is consumed into the replacement
  });
  test("a SUGGEST reply mid-thread inherits the thread's anchor span (accept edits span, keeps the conversation)", () => {
    const text = "Pay {==the old span==}{>>@a: what about rewording?<<}{>>@b: SUGGEST: the new span<<} here.";
    const reply = scanTokens(text)
      .filter((t): t is CommentToken => t.type === "comment")
      .find((c) => c.body.includes("the new span"))!;
    // a reply deep in the thread is still recognised + applyable (inherits the root's anchor)
    expect(applicableSuggestionIds(text).has(reply.id)).toBe(true);
    expect(inlineSuggestions(text).some((s) => s.commentFrom === reply.from && s.hasReplies)).toBe(true);
    const acc = applySuggestionEdit(text, reply)!;
    expect(text.slice(0, acc.from) + acc.insert + text.slice(acc.to)).toBe(
      "Pay {==the new span==}{>>@a: what about rewording?<<} here.",
    );
    const rej = rejectSuggestionEdit(text, reply)!;
    expect(text.slice(0, rej.from) + rej.insert + text.slice(rej.to)).toBe(
      "Pay {==the old span==}{>>@a: what about rewording?<<} here.",
    );
  });
  test("delete (empty replacement) with remaining discussion → point comments, no empty {====}", () => {
    const text = "Cut {==this span==}{>>@a: SUGGEST:<<}{>>@b: agreed<<} now.";
    const sug = scanTokens(text)
      .filter((t): t is CommentToken => t.type === "comment")
      .find((c) => suggestionReplacement(c.body) !== null)!;
    const acc = applySuggestionEdit(text, sug)!;
    expect(text.slice(0, acc.from) + acc.insert + text.slice(acc.to)).toBe("Cut {>>@b: agreed<<} now.");
  });
  test("rejectSuggestionEdit keeps the original span, drops the markup (mirror of accept=new/reject=old)", () => {
    const text = "Pay {==implies a sacrifice==}{>>@claude: SUGGEST: implies a cost<<} here.";
    const sug = scanTokens(text).find((t) => t.type === "comment") as CommentToken;
    const rej = rejectSuggestionEdit(text, sug)!;
    const out = text.slice(0, rej.from) + rej.insert + text.slice(rej.to);
    expect(out).toBe("Pay implies a sacrifice here."); // original span kept, suggestion gone
    // accept and reject hit the SAME range — only the inserted text differs.
    const acc = applySuggestionEdit(text, sug)!;
    expect({ from: rej.from, to: rej.to }).toEqual({ from: acc.from, to: acc.to });
    expect(rej.insert).toBe("implies a sacrifice");
    expect(acc.insert).toBe("implies a cost");
  });
  test("rejectSuggestionEdit returns null for a non-suggestion / unanchored comment", () => {
    const plain = scanTokens("{==s==}{>>@a: note<<}").find((t) => t.type === "comment") as CommentToken;
    expect(rejectSuggestionEdit("{==s==}{>>@a: note<<}", plain)).toBeNull();
    const pt = scanTokens("x {>>@a: SUGGEST: y<<}").find((t) => t.type === "comment") as CommentToken;
    expect(rejectSuggestionEdit("x {>>@a: SUGGEST: y<<}", pt)).toBeNull();
  });
  test("inlineSuggestions surfaces each anchored SUGGEST with its span, replacement, and hasReplies", () => {
    // one bare suggestion + one with a reply thread + a plain anchored comment (ignored).
    const text =
      "A {==s1==}{>>@a: SUGGEST: r1<<} B {==s2==}{>>@b: SUGGEST: r2<<}{>>@c: good idea<<} C {==s3==}{>>@d: note<<}";
    const list = inlineSuggestions(text);
    expect(list.length).toBe(2);
    const [a, b] = list;
    expect(a.replacement).toBe("r1");
    expect(a.hasReplies).toBe(false);
    expect(a.threadCount).toBe(1); // lone suggestion → no badge
    expect(text.slice(a.hlFrom, a.hlTo)).toBe("{==s1==}");
    expect(text.slice(a.commentFrom, a.commentTo)).toBe("{>>@a: SUGGEST: r1<<}");
    expect(b.replacement).toBe("r2");
    expect(b.hasReplies).toBe(true); // @c reply hangs off it — don't hide the thread
    expect(b.threadCount).toBe(2); // SUGGEST + @c reply → "💬 2" badge
  });
  test("applicableSuggestionIds = exactly the SUGGEST: comments whose Apply is real", () => {
    // anchored (real) + zero-gap, anchored with a stray space (real), an unanchored
    // point SUGGEST: (no anchor → excluded), and a plain comment (not a suggestion).
    const text =
      "A {==s1==}{>>@a: SUGGEST: r1<<} B {==s2==} {>>@b: SUGGEST: r2<<} C {>>@c: SUGGEST: r3<<} D {==s4==}{>>@d: plain<<}";
    const ids = applicableSuggestionIds(text);
    const comments = scanTokens(text).filter((t): t is CommentToken => t.type === "comment");
    const byBody = (needle: string) => comments.find((c) => c.body.includes(needle))!;
    expect(ids.has(byBody("r1").id)).toBe(true); // anchored, zero-gap
    expect(ids.has(byBody("r2").id)).toBe(true); // anchored across a space
    expect(ids.has(byBody("r3").id)).toBe(false); // SUGGEST: but no highlight anchor
    expect(ids.has(byBody("plain").id)).toBe(false); // anchored but not a SUGGEST:
    expect(ids.size).toBe(2);
  });
});

describe("formatComment — close-marker round-trip is faithful", () => {
  test("a body containing <<} survives format → scan unchanged", () => {
    const raw = formatComment("claude", "use <<} to close");
    const [t] = scanTokens(raw) as [CommentToken];
    expect(t.type).toBe("comment");
    expect(t.author).toBe("claude");
    // The displayed body restores the literal <<} (no stray zero-width space).
    expect(t.body).toBe("use <<} to close");
  });
});
