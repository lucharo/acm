import { describe, expect, test } from "bun:test";

import { commentSegments } from "./commentLinks";

describe("commentSegments", () => {
  test("links a bare URL and leaves sentence punctuation outside it", () => {
    expect(commentSegments("The wording is Karpathy's (https://x.com/karpathy/status/205).")).toEqual([
      { kind: "text", text: "The wording is Karpathy's (" },
      { kind: "link", text: "https://x.com/karpathy/status/205", href: "https://x.com/karpathy/status/205" },
      { kind: "text", text: ")." },
    ]);
  });

  test("keeps a closing paren that the URL itself opened", () => {
    expect(commentSegments("see https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "link",
        text: "https://en.wikipedia.org/wiki/Foo_(bar)",
        href: "https://en.wikipedia.org/wiki/Foo_(bar)",
      },
    ]);
  });

  test("renders a Markdown link by its label", () => {
    expect(commentSegments("See [the thread](https://example.com/t?id=1) first")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "the thread", href: "https://example.com/t?id=1" },
      { kind: "text", text: " first" },
    ]);
  });

  test("keeps balanced parens inside a Markdown link destination", () => {
    expect(commentSegments("[source](https://en.wikipedia.org/wiki/Foo_(bar)).")).toEqual([
      { kind: "link", text: "source", href: "https://en.wikipedia.org/wiki/Foo_(bar)" },
      { kind: "text", text: "." },
    ]);
  });

  test("never links a non-http target", () => {
    expect(commentSegments("[click](javascript:alert(1)) and data:text/html,x")).toEqual([
      { kind: "text", text: "[click](javascript:alert(1)) and data:text/html,x" },
    ]);
  });

  test("returns plain text unchanged as one segment", () => {
    expect(commentSegments("no links here")).toEqual([{ kind: "text", text: "no links here" }]);
  });
});
