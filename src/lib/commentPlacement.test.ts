import { describe, expect, test } from "bun:test";

import {
  applicableSuggestionIds,
  insertComment,
  pointCommentInsert,
  validateMarkup,
  widenToLiterals,
  wrappableSpan,
} from "./criticmarkup";

const place = (doc: string, at: number, marker = "{>>@You: x<<}") => {
  const r = pointCommentInsert(doc, at, marker);
  return doc.slice(0, r.from) + r.insert + doc.slice(r.from);
};

describe("point comments never land inside an anchor (#72)", () => {
  test("a comment typed inside an agent's anchor joins the end of that anchor's thread", () => {
    const doc = "While {==@david==}{>>@claude: Same person?<<}{>>@claude: SUGGEST: @David Bernick<<} works on";
    const insideAnchor = doc.indexOf("==}");

    const out = place(doc, insideAnchor);

    expect(out).toBe(
      "While {==@david==}{>>@claude: Same person?<<}{>>@claude: SUGGEST: @David Bernick<<}{>>@You: x<<} works on",
    );
    expect(validateMarkup(out)).toEqual([]);
    expect(applicableSuggestionIds(out).size).toBe(1);
  });

  test("inside the inner anchor of a stacked thread, the comment goes after the whole stack", () => {
    const doc = "a {=={==span==}{>>@a: c0<<}==}{>>@b: c1<<} b";

    expect(place(doc, doc.indexOf("span") + 2)).toBe("a {=={==span==}{>>@a: c0<<}==}{>>@b: c1<<}{>>@You: x<<} b");
  });

  test("a whitespace-separated comment after the thread is another card: the reply stops before it", () => {
    const doc = "{==word==}{>>@a: anchored<<} {>>@b: separate<<} tail";

    expect(place(doc, 4)).toBe("{==word==}{>>@a: anchored<<}{>>@You: x<<} {>>@b: separate<<} tail");
  });

  test("inside a bare highlight, the comment anchors on it", () => {
    const doc = "a {==span==} b";

    expect(place(doc, 6)).toBe("a {==span==}{>>@You: x<<} b");
  });

  test("inside a tracked change, the comment goes just after it with a space", () => {
    const doc = "a {++added text++} b";

    expect(place(doc, 8)).toBe("a {++added text++} {>>@You: x<<} b");
  });

  test("plain prose keeps today's behaviour: a separating space before the comment", () => {
    expect(place("one two", 3)).toBe("one {>>@You: x<<} two");
    expect(place("one two", 4)).toBe("one {>>@You: x<<}two");
  });

  test("the server path (insertComment) uses the same placement", () => {
    const doc = "While {==@david==}{>>@claude: hm<<} works";

    expect(insertComment(doc, doc.indexOf("==}"), "yes", "You")).toBe(
      "While {==@david==}{>>@claude: hm<<}{>>@You: yes<<} works",
    );
  });
});

describe("comments never land inside a code span (#71)", () => {
  const line = "(or let your agent do it: `bunx --bun skills add x --skill y`)";
  const bunx = line.indexOf("bunx");

  test("a point comment inside backticks moves past the closing backtick", () => {
    expect(place(line, bunx + 4)).toBe(
      "(or let your agent do it: `bunx --bun skills add x --skill y` {>>@You: x<<})",
    );
  });

  test("a selection inside a code span widens to the whole span, backticks included", () => {
    expect(widenToLiterals(line, bunx, bunx + 4)).toEqual({
      from: line.indexOf("`"),
      to: line.lastIndexOf("`") + 1,
    });
  });

  test("a span that cuts a code span is not wrappable; the whole code span is", () => {
    expect(wrappableSpan(line, bunx, bunx + 4)).toBe(false);
    expect(wrappableSpan(line, line.indexOf("`"), line.lastIndexOf("`") + 1)).toBe(true);
    expect(wrappableSpan(line, 0, line.lastIndexOf("`") + 1)).toBe(true);
  });

  test("a highlight-shaped example inside backticks is code, not an anchor", () => {
    const doc = "See `{==word==}`.";

    expect(place(doc, doc.indexOf("word") + 2)).toBe("See `{==word==}` {>>@You: x<<}.");
  });

  test("a point comment inside a fenced block goes on its own paragraph after the fence", () => {
    const doc = "para\n\n```\ncode here\n```\nnext line";

    expect(place(doc, doc.indexOf("code") + 2)).toBe("para\n\n```\ncode here\n```\n\n{>>@You: x<<}\n\nnext line");
    expect(place("```\ncode\n```", 6)).toBe("```\ncode\n```\n\n{>>@You: x<<}");
  });

  test("a link's destination is never wrapped: selection widens to the whole link, a point comment goes after it", () => {
    const doc = "Go to [site](https://example.com) now";
    const url = doc.indexOf("https");

    expect(widenToLiterals(doc, url + 2, url + 6)).toEqual({ from: doc.indexOf("["), to: doc.indexOf(")") + 1 });
    expect(wrappableSpan(doc, url, url + "https://example.com".length)).toBe(false);
    expect(place(doc, url + 4)).toBe("Go to [site](https://example.com) {>>@You: x<<} now");
    // The link text stays ordinary prose: it can still be anchored on its own.
    expect(wrappableSpan(doc, doc.indexOf("site"), doc.indexOf("site") + 4)).toBe(true);
  });

  test("a comment at the exact end of a fenced block also goes on its own paragraph", () => {
    const doc = "```\ncode\n```\nnext";

    expect(place(doc, doc.indexOf("\nnext"))).toBe("```\ncode\n```\n\n{>>@You: x<<}\n\nnext");
  });

  test("a one-line indented code block is a block: refused for anchors, comment goes after it", () => {
    const doc = "para\n\n    code line\n\nnext";
    const code = doc.indexOf("code");

    expect(wrappableSpan(doc, code, code + 4)).toBe(false);
    expect(wrappableSpan(doc, doc.indexOf("    code"), doc.indexOf("line") + 4)).toBe(false);
    expect(place(doc, code + 2)).toBe("para\n\n    code line\n\n{>>@You: x<<}\n\nnext");
  });

  test("empty and reference link destinations are protected too", () => {
    const empty = "Go [site]() now";
    const ref = "Go [site][ref] now\n\n[ref]: https://example.com";

    expect(place(empty, empty.indexOf("()") + 1)).toBe("Go [site]() {>>@You: x<<} now");
    expect(place(ref, ref.indexOf("[ref]") + 2)).toBe("Go [site][ref] {>>@You: x<<} now\n\n[ref]: https://example.com");
    expect(widenToLiterals(ref, ref.indexOf("[ref]") + 1, ref.indexOf("[ref]") + 3)).toEqual({ from: 3, to: 14 });
  });

  test("a selection inside a fenced block is refused, not widened over the fence", () => {
    const doc = "para\n\n```\ncode here\n```\n";
    const code = doc.indexOf("code");

    expect(widenToLiterals(doc, code, code + 4)).toEqual({ from: code, to: code + 4 });
    expect(wrappableSpan(doc, code, code + 4)).toBe(false);
  });

  test("a span swallowing a whole fenced block (no blank line) is refused", () => {
    const doc = "text\n```\ncode\n```\nmore";

    expect(wrappableSpan(doc, 0, doc.length)).toBe(false);
  });

  test("prose with no literals is untouched", () => {
    expect(widenToLiterals("plain words", 2, 5)).toEqual({ from: 2, to: 5 });
  });
});
