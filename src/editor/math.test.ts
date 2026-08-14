import { describe, expect, test } from "bun:test";

import { findMathRanges } from "./math";

describe("LaTeX source ranges", () => {
  test("finds inline and display math without consuming surrounding prose", () => {
    expect(findMathRanges("Mass $E = mc^2$ and $$\\int_0^1 x dx$$.")).toEqual([
      { from: 5, to: 15, latex: "E = mc^2", display: false },
      { from: 20, to: 37, latex: "\\int_0^1 x dx", display: true },
    ]);
  });

  test("ignores escaped dollars, currency prose, and Markdown code literals", () => {
    const source = [
      "Cost \\$5, then $x+1$. Inline `$raw$`.",
      "",
      "```",
      "$also_raw$",
      "```",
    ].join("\n");

    expect(findMathRanges(source)).toEqual([
      {
        from: source.indexOf("$x+1$"),
        to: source.indexOf("$x+1$") + "$x+1$".length,
        latex: "x+1",
        display: false,
      },
    ]);
    expect(findMathRanges("It costs $5 and $6 tomorrow.")).toEqual([]);
  });
});
