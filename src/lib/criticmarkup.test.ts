import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applySuggestion,
  applySuggestionToken,
  countWords,
  formatComment,
  groupThreads,
  insertComment,
  scanTokens,
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
    // ids unique & in document order.
    expect(tokens.map((t) => t.id)).toEqual(tokens.map((_, i) => String(i)));
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
