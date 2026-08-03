import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { GFM, parser as markdownParser } from "@lezer/markdown";

import { CriticMarkup } from "./criticMarkupParser";
import { extractMarkdownTable, tablePreviewForNode } from "./markdownTable";

const parser = markdownParser.configure([GFM, CriticMarkup]);

function tableNode(source: string): SyntaxNode | null {
  let table: SyntaxNode | null = null;
  parser.parse(source).iterate({
    enter(node) {
      if (node.name === "Table") table = node.node;
    },
  });
  return table;
}

describe("Markdown table model", () => {
  test("extracts a standard GFM pipe table", () => {
    const source = "| Name | Quantity |\n| --- | --- |\n| Tea | 2 |\n| Coffee | 1 |";
    const state = EditorState.create({ doc: source });
    const node = tableNode(source);

    expect(node).not.toBeNull();
    expect(extractMarkdownTable(state.doc, node!)).toEqual({
      from: 0,
      to: source.length,
      source,
      header: ["Name", "Quantity"],
      alignments: [null, null],
      rows: [
        ["Tea", "2"],
        ["Coffee", "1"],
      ],
    });
  });

  test("reads left, centre, and right alignment from the separator row", () => {
    const source = "Left | Centre | Right\n:--- | :----: | ----:\na | b | c";
    const state = EditorState.create({ doc: source });
    const node = tableNode(source);

    expect(node).not.toBeNull();
    expect(extractMarkdownTable(state.doc, node!)?.alignments).toEqual([
      "left",
      "center",
      "right",
    ]);
  });

  test("does not recognise pipe prose or malformed table text", () => {
    const nonTables = [
      "ordinary prose | with a pipe",
      "name | quantity\nthis is not a separator",
      "name | quantity\n---\nTea | 2",
    ];

    expect(nonTables.map((source) => tableNode(source))).toEqual([null, null, null]);
  });

  test("renders only while inactive and never changes the Markdown source", () => {
    const source = "Before\n\n| Name | Quantity |\n| --- | ---: |\n| Tea | 2 |\n\nAfter";
    const state = EditorState.create({ doc: source });
    const node = tableNode(source);
    const before = state.doc.toString();

    expect(node).not.toBeNull();
    expect(tablePreviewForNode(state.doc, node!, [], false)).not.toBeNull();

    const cellCursor = source.indexOf("Tea");
    expect(
      tablePreviewForNode(
        state.doc,
        node!,
        [{ from: cellCursor, to: cellCursor }],
        true,
      ),
    ).toBeNull();

    const afterCursor = source.indexOf("After");
    expect(
      tablePreviewForNode(
        state.doc,
        node!,
        [{ from: afterCursor, to: afterCursor }],
        true,
      ),
    ).not.toBeNull();
    expect(state.doc.toString()).toBe(before);
  });
});
