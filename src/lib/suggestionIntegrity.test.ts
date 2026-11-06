import { describe, expect, test } from "bun:test";

import {
  acceptedMarkdown,
  applicableSuggestionIds,
  healDocument,
  resolveAnchorEdit,
  scanTokens,
  validateMarkup,
} from "./criticmarkup";

const kinds = (doc: string) => validateMarkup(doc).map((d) => d.kind);

describe("SUGGEST integrity diagnostics (#65, #28, #72)", () => {
  test("a SUGGEST behind an anchor that wraps another thread is flagged, not silently dead (#65 repro a)", () => {
    const doc =
      "{=={==Old sentence==}{>>@You: note<<} rest of paragraph==}{>>@codex: SUGGEST: replacement<<}";

    expect(kinds(doc)).toEqual(["comment-in-anchor", "orphan-suggestion"]);
  });

  test("an orphaned deletion SUGGEST is flagged (#65 repro b)", () => {
    const doc = "{=={==TRL ==}{>>@You: move this<<}rest of paragraph==}{>>@codex: SUGGEST:<<}";

    expect(kinds(doc)).toEqual(["comment-in-anchor", "orphan-suggestion"]);
  });

  test("a point SUGGEST with no highlight at all is flagged as orphaned", () => {
    expect(kinds("text {>>@a: SUGGEST: x<<} more")).toEqual(["orphan-suggestion"]);
  });

  test("a SUGGEST whose anchor wraps an editor reply is flagged (#72)", () => {
    const doc =
      "While {==@david {>>@You: ~acm1~it's same david bernick <<}==}{>>@claude: Same person?<<}{>>@claude: SUGGEST: @David Bernick<<} works on";

    expect(kinds(doc)).toEqual(["comment-in-anchor", "orphan-suggestion"]);
  });

  test("prose followed by SUGGEST: in one comment is flagged (#28)", () => {
    const doc = "c {==the span==}{>>@claude: Moving it now: deletes the span. SUGGEST: <<} d";

    expect(validateMarkup(doc)).toEqual([
      {
        from: 16,
        to: 19,
        kind: "mixed-suggestion",
        message:
          "this comment mixes prose with SUGGEST: — it shows as a plain note; put the suggestion in a comment of its own",
      },
    ]);
  });

  test("valid suggestions stay clean: root, mid-thread reply, stacked thread, deletion", () => {
    const docs = [
      "a {==span==}{>>@claude: SUGGEST: new<<} b",
      "a {==span==}{>>@You: q<<}{>>@claude: SUGGEST: new<<} b",
      "x {=={==old span==}{>>@a: SUGGEST: new span<<}==}{>>@b: keep talking<<} y",
      "{=={==span==}{>>@a: c0<<}==}{>>@b: c1<<}",
      "Cut {==this span==}{>>@a: SUGGEST:<<}{>>@b: agreed<<} now.",
      "a comment that says suggest: nothing {==s==}{>>@a: please suggest an edit<<}",
    ];

    expect(docs.map(kinds)).toEqual([[], [], [], [], [], []]);
  });
});

describe("heal repairs SUGGEST threads (#65, #72)", () => {
  test("a reply typed inside the anchor is lifted after the thread, and its SUGGEST applies again (#72)", () => {
    const doc =
      "While {==@david {>>@You: ~acm1~it's same david bernick <<}==}{>>@claude: Same person?<<}{>>@claude: SUGGEST: @David Bernick<<} works on";

    const healed = healDocument(doc);

    expect(healed).toBe(
      "While {==@david==}{>>@claude: Same person?<<}{>>@claude: SUGGEST: @David Bernick<<}{>>@You: ~acm1~it's same david bernick <<} works on",
    );
    expect(validateMarkup(healed)).toEqual([]);
    expect(applicableSuggestionIds(healed).size).toBe(1);
  });

  test("an anchor wrapping another thread is flattened onto its full prose; every word and comment survives (#65)", () => {
    const doc =
      "{=={==Old sentence==}{>>@You: note<<} rest of paragraph==}{>>@codex: SUGGEST: replacement<<}";

    const healed = healDocument(doc);

    expect(healed).toBe(
      "{==Old sentence rest of paragraph==}{>>@codex: SUGGEST: replacement<<}{>>@You: note<<}",
    );
    expect(validateMarkup(healed)).toEqual([]);
  });

  test("a nested anchor with no SUGGEST on the outer thread is left alone (it displays fine)", () => {
    const doc = "{==all {==skips==}{>>@L: ??<<} are systems==}{>>@L: Yes, this is what we said.<<} next";

    expect(validateMarkup(doc)).toEqual([]);
    expect(healDocument(doc)).toBe(doc);
  });

  test("an inner SUGGEST is never retargeted onto the outer span: flagged, left for a human", () => {
    const doc =
      "{==prefix {==word==}{>>@a: SUGGEST: new<<} suffix==}{>>@b: SUGGEST: whole<<} end";

    expect(validateMarkup(doc).map((d) => [d.kind, d.message])).toEqual([
      ["comment-in-anchor", "a comment sits inside this highlight's span — its thread can't anchor; move it out by hand"],
      ["orphan-suggestion", "SUGGEST card has no anchored span, so it can't be applied — put {==the span==} right before it"],
    ]);
    expect(healDocument(doc)).toBe(doc);
  });

  test("markup examples inside code are neither flagged nor healed", () => {
    const doc =
      "Example: `{>>@claude<<}:` and `{>>@claude: ` and `{=={==a==}{>>@x: n<<} b==}{>>@y: SUGGEST: z<<}` and `{>>@a: SUGGEST: q<<}`";

    // The delimiter scan predates literal awareness (export filters it); the
    // review-integrity checks must not add to it.
    const integrity = new Set(["comment-in-anchor", "orphan-suggestion", "mixed-suggestion", "mangled-comment"]);
    expect(validateMarkup(doc).filter((d) => integrity.has(d.kind))).toEqual([]);
    expect(healDocument(doc)).toBe(doc);
  });

  test("a code example inside an anchor is prose, not a comment to lift", () => {
    const doc = "{==Use `{>>@a: example<<}` today==}{>>@b: note<<} end";

    expect(validateMarkup(doc)).toEqual([]);
    expect(healDocument(doc)).toBe(doc);
  });

  test("a space that belonged to the span survives the heal (no 'wordtail')", () => {
    expect(healDocument("{==word {>>@u: note<<}==}tail")).toBe("{==word==}{>>@u: note<<} tail");
  });

  test("a literal ==} inside a tracked change in the span survives the heal", () => {
    expect(healDocument("{==a {++x ==} y++} {>>@u: note<<} tail==}{>>@b: SUGGEST: z<<} end")).toBe(
      "{==a {++x ==} y++} tail==}{>>@b: SUGGEST: z<<}{>>@u: note<<} end",
    );
  });

  test("a Markdown hard break (two trailing spaces) survives the heal", () => {
    expect(healDocument("{==word  {>>@u: note<<}==}\nnext")).toBe("{==word ==}{>>@u: note<<} \nnext");
  });

  test("lifted comments join the anchor's own thread, never a separate card after it", () => {
    const doc = "{==word {>>@u: inline<<}==}{>>@a: parent<<} {>>@b: separate<<} end";

    expect(healDocument(doc)).toBe("{==word==}{>>@a: parent<<}{>>@u: inline<<} {>>@b: separate<<} end");
  });

  test("an inner anchor with replies is a nested anchor, not a bare comment", () => {
    const doc = "{==all {==skips==}{>>@a: root<<}{>>@b: reply<<} are systems==}{>>@c: outer<<} next";

    expect(validateMarkup(doc)).toEqual([]);
    expect(healDocument(doc)).toBe(doc);
  });

  test("heal leaves the legitimate stacked-thread shape alone", () => {
    const doc = "{=={==span==}{>>@a: c0<<}==}{>>@b: c1<<}";

    expect(healDocument(doc)).toBe(doc);
  });
});

describe("heal repairs the two corrupted empty-SUGGEST shapes (#47)", () => {
  test("a comment that lost its body, with the stray colon leaked into prose", () => {
    const doc =
      "{==Elliot, I want to help you.==}{>>@claude: hi<<}{>>@You: suggest edit<<}{>>@claude<<}:  The rock wanted to help.";

    expect(kinds(doc)).toEqual(["mangled-comment"]);
    const healed = healDocument(doc);
    expect(healed).toBe(
      "{==Elliot, I want to help you.==}{>>@claude: hi<<}{>>@You: suggest edit<<} The rock wanted to help.",
    );
    expect(validateMarkup(healed)).toEqual([]);
  });

  test("an unterminated, bodiless comment at the end of a line", () => {
    const doc =
      "{==- need here to finish the story==}{>>@claude: hm<<}{>>@You: suggest edit<<}{>>@claude: \n\nNext {==para==}{>>@a: ok<<}.";

    expect(kinds(doc)).toEqual(["dangling-open"]);
    const healed = healDocument(doc);
    expect(healed).toBe(
      "{==- need here to finish the story==}{>>@claude: hm<<}{>>@You: suggest edit<<}\n\nNext {==para==}{>>@a: ok<<}.",
    );
    expect(validateMarkup(healed)).toEqual([]);
  });

  test("an unterminated comment that still carries words is NOT deleted", () => {
    const doc = "a {>>@claude: real words here\n\nNext.";

    expect(healDocument(doc)).toBe(doc);
  });
});

describe("accepted Markdown never leaks anchor delimiters", () => {
  test("a stacked thread exports its plain prose", () => {
    expect(acceptedMarkdown("x {=={==span==}{>>@a: c0<<}==}{>>@b: c1<<} y")).toEqual({
      ok: true,
      markdown: "x span y",
    });
  });

  test("an orphaned SUGGEST does not block export and leaks nothing (#65)", () => {
    const doc =
      "{=={==Old sentence==}{>>@You: note<<} rest of paragraph==}{>>@codex: SUGGEST: replacement<<}";

    expect(acceptedMarkdown(doc)).toEqual({ ok: true, markdown: "Old sentence rest of paragraph" });
  });

  test("a literal ==} inside a tracked change and an escaped example survive export", () => {
    expect(acceptedMarkdown("{++x ==} y++} and \\{==not a highlight==} z")).toEqual({
      ok: true,
      markdown: "x ==} y and \\{==not a highlight==} z",
    });
  });

  test("anchor-shaped text inside a code span stays literal", () => {
    const doc = "use `{==x==}` here {==real==}{>>@a: c<<}";

    expect(acceptedMarkdown(doc)).toEqual({ ok: true, markdown: "use `{==x==}` here real" });
  });
});

test("scanTokens is untouched by the new checks (sanity)", () => {
  expect(scanTokens("{==a==}{>>@x: SUGGEST: b<<}").map((t) => t.type)).toEqual(["highlight", "comment"]);
});

describe("resolve uses the same gap-tolerant anchor rule as apply", () => {
  test("a stray space between span and comment: resolving leaves plain prose, no orphaned highlight", () => {
    const doc = "A {==fact==} {>>@a: source<<} end.";
    const c = scanTokens(doc).find((t) => t.type === "comment")!;

    const edit = resolveAnchorEdit(doc, c.from, c.to);

    expect(doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to)).toBe("A fact end.");
  });
});
