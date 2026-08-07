import { describe, expect, test } from "bun:test";

import { preparePrintDocument, referenceSideForPage } from "./printDocument";

const SOURCE = [
  "# Field notes",
  "",
  "The main claim has evidence[^method].",
  "",
  "> A short aside with *emphasis*.",
  "",
  "A second claim has another note[^second].",
  "",
  "[^method]: Method detail with **strong text**.",
  "[^second]: Another note.",
].join("\n");

describe("print document preparation", () => {
  test("simple print keeps quotes in the article and collects footnotes as endnotes", () => {
    expect(preparePrintDocument(SOURCE, "simple", true)).toEqual({
      style: "simple",
      footnoteLabels: { method: "1", second: "2" },
      rows: [
        { markdown: "# Field notes", references: [] },
        { markdown: "The main claim has evidence[^method].", references: [] },
        { markdown: "> A short aside with *emphasis*.", references: [] },
        { markdown: "A second claim has another note[^second].", references: [] },
      ],
      endnotes: [
        {
          id: "method",
          kind: "footnote",
          label: "1",
          markdown: "Method detail with **strong text**.",
          side: null,
        },
        {
          id: "second",
          kind: "footnote",
          label: "2",
          markdown: "Another note.",
          side: null,
        },
      ],
    });
  });

  test("Tufte print keeps references sharing a page on the same initial outer rib", () => {
    expect(preparePrintDocument(SOURCE, "tufte", true)).toEqual({
      style: "tufte",
      footnoteLabels: { method: "1", second: "2" },
      rows: [
        { markdown: "# Field notes", references: [] },
        {
          markdown: "The main claim has evidence[^method].",
          references: [
            {
              id: "method",
              kind: "footnote",
              label: "1",
              markdown: "Method detail with **strong text**.",
              side: "right",
            },
            {
              id: "quote-1",
              kind: "quote",
              label: "Quote",
              markdown: "A short aside with *emphasis*.",
              side: "right",
            },
          ],
        },
        {
          markdown: "A second claim has another note[^second].",
          references: [
            {
              id: "second",
              kind: "footnote",
              label: "2",
              markdown: "Another note.",
              side: "right",
            },
          ],
        },
      ],
      endnotes: [],
    });
  });

  test("does not interpret a footnote-shaped code line as a real definition", () => {
    const source = [
      "```md",
      "[^literal]: keep this code",
      "```",
      "",
      "Body[^real].",
      "",
      "[^real]: Actual note.",
    ].join("\n");

    expect(preparePrintDocument(source, "simple", true)).toEqual({
      style: "simple",
      footnoteLabels: { real: "1" },
      rows: [
        { markdown: "```md\n[^literal]: keep this code\n```", references: [] },
        { markdown: "Body[^real].", references: [] },
      ],
      endnotes: [
        {
          id: "real",
          kind: "footnote",
          label: "1",
          markdown: "Actual note.",
          side: null,
        },
      ],
    });
  });

  test("anchors a note to the first real reference, not inline code or an escape", () => {
    const source = [
      "Literal `[^one]` and escaped \\[^one].",
      "",
      "The real claim[^one].",
      "",
      "[^one]: Actual note.",
    ].join("\n");

    const model = preparePrintDocument(source, "tufte", true);

    expect(model.rows).toEqual([
      { markdown: "Literal `[^one]` and escaped \\[^one].", references: [] },
      {
        markdown: "The real claim[^one].",
        references: [
          {
            id: "one",
            kind: "footnote",
            label: "1",
            markdown: "Actual note.",
            side: "right",
          },
        ],
      },
    ]);
  });

  test("preserves UTF-16 offsets when an emoji appears before a footnote definition", () => {
    const source = "Emoji 😀 body[^one].\n\n[^one]: Note.";

    expect(preparePrintDocument(source, "simple", true)).toEqual({
      style: "simple",
      footnoteLabels: { one: "1" },
      rows: [{ markdown: "Emoji 😀 body[^one].", references: [] }],
      endnotes: [
        {
          id: "one",
          kind: "footnote",
          label: "1",
          markdown: "Note.",
          side: null,
        },
      ],
    });
  });

  test("fixed-side Tufte print keeps every reference on the right", () => {
    const model = preparePrintDocument(SOURCE, "tufte", false);

    expect(model.rows.flatMap((row) => row.references.map((reference) => reference.side))).toEqual([
      "right",
      "right",
      "right",
    ]);
  });

  test("alternating book pages keep each page's references on its outer margin", () => {
    expect([
      referenceSideForPage(0, true),
      referenceSideForPage(1, true),
      referenceSideForPage(2, true),
      referenceSideForPage(3, true),
    ]).toEqual(["right", "left", "right", "left"]);
    expect(referenceSideForPage(1, false)).toBe("right");
  });

  test("long blockquotes stay in the article to avoid overflowing the rib", () => {
    const longQuote = `> ${"A deliberately long quotation remains in the article. ".repeat(5)}`;
    const model = preparePrintDocument(longQuote, "tufte", true);

    expect(model.rows).toEqual([{ markdown: longQuote, references: [] }]);
  });
});
