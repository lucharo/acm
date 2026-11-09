import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { countWords, pageBreakLines } from "../lib/criticmarkup";
import { findMathRanges } from "./math";
import { pageBreaks } from "./pageBreaks";

interface Gap {
  pos: number;
  block: boolean;
}

function gapsIn(doc: string): Gap[] {
  const state = EditorState.create({ doc, extensions: pageBreaks });
  const gaps: Gap[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(null as never) : source;
    set.between(0, doc.length, (from, _to, deco) => {
      gaps.push({ pos: from, block: Boolean(deco.spec.block) });
    });
  }
  return gaps.sort((a, b) => a.pos - b.pos);
}

/** Sentences of ten words each, so a sentence start falls every ten words. */
function paragraph(words: number): string {
  const sentences: string[] = [];
  for (let n = 0; n < words / 10; n += 1) sentences.push(`${"word ".repeat(9)}end.`);
  return sentences.join(" ");
}

describe("page gaps in the editor", () => {
  test("a paragraph longer than a page breaks inside itself into even sheets", () => {
    const doc = paragraph(1300);

    const gaps = gapsIn(doc);

    expect(gaps).toEqual([
      { pos: doc.indexOf("word", 550 * 5), block: false },
      { pos: doc.indexOf("word", 1100 * 5), block: false },
    ]);
    const sheets = [doc.slice(0, gaps[0].pos), doc.slice(gaps[0].pos, gaps[1].pos), doc.slice(gaps[1].pos)];
    expect(sheets.map(countWords)).toEqual([550, 550, 200]);
  });

  test("an ordinary paragraph keeps its break at the paragraph edge", () => {
    const first = paragraph(500);
    const second = paragraph(120);
    const doc = `${first}\n\n${second}`;

    const gaps = gapsIn(doc);

    expect(gaps).toEqual([{ pos: first.length + 2, block: true }]);
  });
});

describe("pageBreakLines inside a long paragraph", () => {
  test("a last paragraph ending just past a page keeps gaps in document order", () => {
    const doc = paragraph(1150);

    const gaps = gapsIn(doc);

    expect(gaps).toEqual([
      { pos: doc.indexOf("word", 550 * 5), block: false },
      { pos: doc.indexOf("word", 1100 * 5), block: false },
    ]);
  });

  test("a trailing newline doesn't push the last break onto an empty sheet", () => {
    const body = paragraph(1150);
    const doc = `${body}\n`;

    const gaps = gapsIn(doc);

    expect(gaps).toEqual([
      { pos: body.indexOf("word", 550 * 5), block: false },
      { pos: body.indexOf("word", 1100 * 5), block: false },
    ]);
  });

  test("never lands inside an image description", () => {
    const image = `![${"described word. ".repeat(8).trim()}](pic.png)`;
    const doc = `${"word ".repeat(92)}${image} ${"word ".repeat(120)}`.trim();

    const { breaks } = pageBreakLines(doc, 100);

    expect(breaks[0].offset).toBeDefined();
    const before = doc.slice(0, breaks[0].offset);
    expect(before.includes("![") && !before.includes("](pic.png)")).toBe(false);
  });

  test("never lands inside inline maths", () => {
    const maths = `$${"a + b. ".repeat(5).trim()}$`;
    const doc = `${"word ".repeat(93)}${maths} ${"word ".repeat(120)}`.trim();

    const { breaks } = pageBreakLines(doc, 100, findMathRanges);

    expect(breaks[0].offset).toBeDefined();
    expect((doc.slice(0, breaks[0].offset).match(/\$/g) ?? []).length % 2).toBe(0);
  });

  test("the editor keeps its gaps out of inline maths", () => {
    const maths = `$${"a + b. ".repeat(10).trim()}$`;
    const doc = `${"word ".repeat(535)}${maths} ${"word ".repeat(300)}`.trim();

    const gaps = gapsIn(doc);

    expect(gaps.length).toBeGreaterThan(0);
    expect((doc.slice(0, gaps[0].pos).match(/\$/g) ?? []).length % 2).toBe(0);
  });

  test("a comment opening the paragraph doesn't hide later maths", () => {
    const maths = `$${"a + b. ".repeat(5).trim()}$`;
    const doc = `{>>@a: a note<<} ${"word ".repeat(93)}${maths} ${"word ".repeat(120)}`.trim();

    const { breaks } = pageBreakLines(doc, 100, findMathRanges);

    expect(breaks[0].offset).toBeDefined();
    expect((doc.slice(0, breaks[0].offset).match(/\$/g) ?? []).length % 2).toBe(0);
  });

  test("a literal dollar pair in code doesn't stop breaks inside the paragraph", () => {
    const doc = `Use \`$$\` for display. ${paragraph(300)}`;

    const { breaks } = pageBreakLines(doc, 100, findMathRanges);

    expect(breaks[0].offset).toBeDefined();
  });

  test("escaped prices are not maths, so a break can land between them", () => {
    const doc = `${"word ".repeat(40)}\\$5 ${"word. ".repeat(60)}\\$6 ${"word ".repeat(100)}`.trim();

    const { breaks } = pageBreakLines(doc, 80, findMathRanges);

    expect(breaks[0].offset).toBeDefined();
  });

  test("counts a standalone plus or minus inside a paragraph as a word", () => {
    const doc = "x + y ".repeat(100).trim();

    const { breaks } = pageBreakLines(doc, 120);

    // Word 120 of "x + y" repeating starts a fresh "x", at offset 40 groups along.
    expect(breaks[0]).toEqual({ line: 1, frac: 120 / 300, offset: 40 * 6 });
  });

  test("backticks in separate comments don't protect the prose between them", () => {
    const doc = `open {>>@a: tick \`<<} ${paragraph(300)} {>>@b: tick \`<<} end.`;

    const { breaks } = pageBreakLines(doc, 100);

    expect(breaks[0].offset).toBeDefined();
  });

  test("a sentence end too far from the boundary loses to the nearest word", () => {
    const doc = `${"word ".repeat(60)}end. ${"word ".repeat(200)}`.trim();

    const { breaks } = pageBreakLines(doc, 100);

    expect(breaks[0].offset).toBe(500);
  });

  test("a boundary inside a long highlight moves to the nearest safe word", () => {
    const highlight = `{==${"held ".repeat(160).trim()}==}`;
    const doc = `${"word ".repeat(470)}${highlight} ${"word ".repeat(670)}`.trim();

    const { breaks } = pageBreakLines(doc, 550);

    expect(breaks[0].offset).toBe(doc.indexOf("==} word") + 4);
  });

  test("a dangling opener before a long paragraph doesn't protect the paragraph", () => {
    const paragraphText = paragraph(300);
    const doc = `stray {==\n\n${paragraphText}\n\nlater {==real==}{>>@a: note<<} end.`;

    const { breaks } = pageBreakLines(doc, 100);

    expect(breaks[0].offset).toBeDefined();
  });

  test("prefers the nearest sentence start over the exact word", () => {
    const doc = `${"word ".repeat(94)}end. ${"more ".repeat(120)}tail.`;

    const { breaks } = pageBreakLines(doc, 100);

    expect(breaks[0].offset).toBe(doc.indexOf("more"));
  });

  test("falls back to the nearest word start when no sentence ends nearby", () => {
    const doc = "word ".repeat(200).trim();

    const { breaks } = pageBreakLines(doc, 100);

    expect(breaks).toEqual([{ line: 1, frac: 0.5, offset: 100 * 5 }]);
  });

  test("never lands inside CriticMarkup or inline code", () => {
    const span = `{==${"held word. ".repeat(8).trim()}==}`;
    const code = `\`${"code word. ".repeat(8).trim()}\``;
    const doc = `${"word ".repeat(60)}${span} ${code} ${"word ".repeat(120)}`.trim();

    const { breaks } = pageBreakLines(doc, 100);

    const before = doc.slice(0, breaks[0].offset);
    expect(before.split("{==").length).toBe(before.split("==}").length);
    expect((before.match(/`/g) ?? []).length % 2).toBe(0);
  });

  test("a table row stays a whole-line break", () => {
    const doc = `| ${"cell ".repeat(240)}|`;

    const { breaks } = pageBreakLines(doc, 100);

    expect(breaks).toEqual([
      { line: 1, frac: 100 / 242 },
      { line: 1, frac: 200 / 242 },
    ]);
  });

  test("a break near the line edge keeps snapping there", () => {
    const doc = `${"word ".repeat(95)}\n${"word ".repeat(30)}`.trim();

    const { breaks } = pageBreakLines(doc, 100);

    expect(breaks).toEqual([{ line: 2, frac: 5 / 30 }]);
  });
});
