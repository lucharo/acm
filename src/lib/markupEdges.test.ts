// Edge cases left over from the review rounds on #84 and #111 (#113, #114, #116).

import { describe, expect, test } from "bun:test";

import { resolveSuggestion } from "./agentEdits";
import { applicableSuggestionIds, formatComment, pointCommentInsert, validateMarkup, wrappableSpan } from "./criticmarkup";

const place = (doc: string, at: number, marker = "{>>@You: x<<}") => {
  const r = pointCommentInsert(doc, at, marker);
  return doc.slice(0, r.from) + r.insert + doc.slice(r.from);
};

describe("#113 a point comment inside a nested anchor's outer span", () => {
  test("goes after the outer anchor's thread, not inside the outer span", () => {
    const doc = "{==all {==skips==}{>>@a: note<<} are systems==}{>>@b: outer<<} next";

    const out = place(doc, doc.indexOf("systems") + "systems".length);

    expect(out).toBe("{==all {==skips==}{>>@a: note<<} are systems==}{>>@b: outer<<}{>>@You: x<<} next");
    expect(validateMarkup(out)).toEqual([]);
  });

  test("inside the inner anchor it still joins the inner thread", () => {
    const doc = "{==all {==skips==}{>>@a: note<<} are systems==}{>>@b: outer<<} next";

    expect(place(doc, doc.indexOf("skips") + 2)).toBe(
      "{==all {==skips==}{>>@a: note<<}{>>@You: x<<} are systems==}{>>@b: outer<<} next",
    );
  });
});

describe("#114 a reference definition is a block", () => {
  const doc = "See [site][ref].\n\n[ref]: https://example.com\n\nNext.";
  const url = doc.indexOf("https");

  test("a point comment in its URL goes on its own paragraph after it", () => {
    expect(place(doc, url + 4)).toBe("See [site][ref].\n\n[ref]: https://example.com\n\n{>>@You: x<<}\n\nNext.");
  });

  test("nothing in it can be anchored", () => {
    expect(wrappableSpan(doc, url, url + 7)).toBe(false);
  });
});

describe("#116 code detection", () => {
  test("a replacement that is code only on its own line is judged in place: unsafe mid-paragraph", () => {
    const doc = `Alpha {==beta==}${formatComment("a", "SUGGEST:     ==}")} gamma.`;

    expect(applicableSuggestionIds(doc).size).toBe(0);
    expect(validateMarkup(doc).map((d) => d.kind)).toEqual(["unsafe-suggestion"]);
    expect(() => resolveSuggestion(doc, "beta", "accept")).toThrow("CriticMarkup delimiters");
  });

  test("backticks in two separate comments don't pair into a code span that hides a SUGGEST", () => {
    const doc = "A {==one==}{>>@a: note `<<}{>>@b: SUGGEST: two`<<}.";

    expect(applicableSuggestionIds(doc).size).toBe(1);
    // Keeping @a's comment would pair its backtick with the replacement's (#9).
    expect(() => resolveSuggestion(doc, "two", "accept")).toThrow(
      '"two": its replacement contains CriticMarkup delimiters, so accepting it would break the markup',
    );
  });
});

describe("#118 review round 1", () => {
  test("a replacement that only balances against an enclosing anchor is still unsafe", () => {
    const doc = "{==outer {==inner==}{>>@a: SUGGEST: ==}<<} tail==}{>>@b: c<<}";

    expect(applicableSuggestionIds(doc).size).toBe(0);
  });

  test("an offset inside the closing ==} is inside the anchor", () => {
    const doc = "{==word==}{>>@a: note<<} x";
    const close = doc.indexOf("==}");

    expect([place(doc, close + 1), place(doc, close + 2)]).toEqual([
      "{==word==}{>>@a: note<<}{>>@You: x<<} x",
      "{==word==}{>>@a: note<<}{>>@You: x<<} x",
    ]);
  });

  test("a SUGGEST followed by comparison prose keeps its Apply", () => {
    expect(applicableSuggestionIds("A {==old==}{>>@a: SUGGEST: new<<} b > c.").size).toBe(1);
  });

  test("a ==} inside inline code within an anchor is not the anchor's close", () => {
    const doc = "{==all {==word==}{>>@a: note<<} use `==}` later==}{>>@b: outer<<} end";

    expect(place(doc, 4)).toBe("{==all {==word==}{>>@a: note<<} use `==}` later==}{>>@b: outer<<}{>>@You: x<<} end");
  });
});

describe("#118 review round 2", () => {
  test("delimiters quoted in two separate code spans stay two code spans", () => {
    const doc = "Use `{>>` to open and `<<}` to close.";

    expect(place(doc, doc.indexOf("to open") + 2)).toBe("Use `{>>` to {>>@You: x<<} open and `<<}` to close.");
  });

  test("a highlight never reaches across paragraphs to claim a comment", () => {
    const doc = "Before {==unfinished\n\nMiddle target\n\nAfter==}{>>@a: note<<}";

    expect(place(doc, doc.indexOf("target") + "target".length)).toBe(
      "Before {==unfinished\n\nMiddle target {>>@You: x<<}\n\nAfter==}{>>@a: note<<}",
    );
  });
});

