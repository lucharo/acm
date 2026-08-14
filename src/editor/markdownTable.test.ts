import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { GFM, parser as markdownParser } from "@lezer/markdown";

import { CriticMarkup } from "./criticMarkupParser";
import { scanTokens, selectionAnnotationEdit } from "../lib/criticmarkup";
import {
  extractMarkdownTable,
  formatMarkdownTable,
  formatMarkdownTableAt,
  nextMarkdownTableCell,
  markdownTableCellRange,
  tablePreviewForNode,
  updateMarkdownTableCell,
} from "./markdownTable";

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

function descendantNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  const visit = (current: SyntaxNode) => {
    names.push(current.name);
    for (let child = current.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(node);
  return names;
}

describe("Markdown table model", () => {
  test("extracts a standard GFM pipe table", () => {
    const source = "| Name | Quantity |\n| --- | --- |\n| Tea | 2 |\n| Coffee | 1 |";
    const state = EditorState.create({ doc: source });
    const node = tableNode(source);

    expect(node).not.toBeNull();
    const model = extractMarkdownTable(state.doc, node!);
    expect(model).toMatchObject({
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
    expect(markdownTableCellRange(model!, { section: "header", row: 0, column: 1 })).toEqual({
      from: source.indexOf("Quantity"),
      to: source.indexOf("Quantity") + "Quantity".length,
    });
    expect(markdownTableCellRange(model!, { section: "body", row: 1, column: 0 })).toEqual({
      from: source.indexOf("Coffee"),
      to: source.indexOf("Coffee") + "Coffee".length,
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

  test("keeps a top-level ordinary table eligible for preview", () => {
    const source = "| A | B |\n| --- | --- |\n| x | y |";
    const state = EditorState.create({ doc: source });
    const node = tableNode(source);

    expect(node?.parent?.name).toBe("Document");
    expect(tablePreviewForNode(state.doc, node!)).not.toBeNull();
  });

  test("keeps comment/highlight table cells rich, but leaves tracked changes raw", () => {
    const source = [
      "| Kind | Value |",
      "| --- | --- |",
      "| insertion | {++new++} |",
      "| highlight | {==mark==} |",
      "| comment | {>>@reviewer: note<<} |",
      "| substitution | {~~old~>new~~} |",
    ].join("\n");
    const state = EditorState.create({ doc: source });
    const node = tableNode(source);

    expect(node?.parent?.name).toBe("Document");
    expect(descendantNames(node!).filter((name) => /^CM(?:Insert|Highlight|Comment|Substitute)$/.test(name))).toEqual([
      "CMInsert",
      "CMHighlight",
      "CMComment",
      "CMSubstitute",
    ]);
    expect(tablePreviewForNode(state.doc, node!)).toBeNull();
    expect(state.doc.toString()).toBe(source);

    const commented = [
      "| Kind | Value |",
      "| --- | --- |",
      "| comment | {==cell==}{>>@reviewer: note<<} |",
    ].join("\n");
    const commentedState = EditorState.create({ doc: commented });
    expect(tablePreviewForNode(commentedState.doc, tableNode(commented)!)).not.toBeNull();
  });

  test("keeps blockquote- and list-nested tables raw", () => {
    const sources = [
      "> | A | B |\n> | --- | --- |\n> | x | y |",
      "- item\n\n  | A | B |\n  | --- | --- |\n  | x | y |",
    ];
    const parsed = sources.map((source) => {
      const state = EditorState.create({ doc: source });
      const node = tableNode(source);
      return {
        parent: node?.parent?.name,
        preview: tablePreviewForNode(state.doc, node!),
        source: state.doc.toString(),
      };
    });

    expect(parsed.map(({ parent }) => parent)).toEqual(["Blockquote", "ListItem"]);
    expect(parsed.map(({ preview }) => preview)).toEqual([null, null]);
    expect(parsed.map(({ source }) => source)).toEqual(sources);
  });

  test("does not recognise pipe prose or malformed table text", () => {
    const nonTables = [
      "ordinary prose | with a pipe",
      "name | quantity\nthis is not a separator",
      "name | quantity\n---\nTea | 2",
    ];

    expect(nonTables.map((source) => tableNode(source))).toEqual([null, null, null]);
  });

  test("global preview eligibility never changes the Markdown source", () => {
    const source = "Before\n\n| Name | Quantity |\n| --- | ---: |\n| Tea | 2 |\n\nAfter";
    const state = EditorState.create({ doc: source });
    const node = tableNode(source);
    const before = state.doc.toString();

    expect(node).not.toBeNull();
    expect(tablePreviewForNode(state.doc, node!)).not.toBeNull();
    expect(state.doc.toString()).toBe(before);
  });

  test("formats raw tables into stable aligned Markdown", () => {
    const source = "Name|Qty|Note\n---|---:|:---:\nTea|2|**hot**\nCoffee beans|10|a\\|b";
    const state = EditorState.create({ doc: source });
    const model = extractMarkdownTable(state.doc, tableNode(source)!);

    expect(model).not.toBeNull();
    expect(formatMarkdownTable(model!)).toBe([
      "| Name         | Qty | Note    |",
      "| ------------ | --: | :-----: |",
      "| Tea          | 2   | **hot** |",
      "| Coffee beans | 10  | a\\|b    |",
    ].join("\n"));
  });

  test("preserves a literal backslash before an escaped pipe when formatting", () => {
    const source = String.raw`| A | B |
| --- | --- |
| x | a\\\|b |`;
    const state = EditorState.create({
      doc: source,
      extensions: [markdown({ base: markdownLanguage, extensions: [CriticMarkup] })],
    });

    expect(formatMarkdownTableAt(state, source.indexOf("a\\"))).toEqual({
      status: "changed",
      change: {
        from: 0,
        to: source.length,
        insert: String.raw`| A   | B      |
| --- | ------ |
| x   | a\\\|b |`,
      },
    });
  });

  test("editing one rich cell returns one complete formatted table replacement", () => {
    const source = "| Capability | Result |\n| --- | --- |\n| Raw editing | Deliberate |";
    const state = EditorState.create({ doc: source });
    const model = extractMarkdownTable(state.doc, tableNode(source)!);

    expect(updateMarkdownTableCell(model!, { section: "body", row: 0, column: 1 }, "**Reversible** and `safe`")).toBe([
      "| Capability  | Result                    |",
      "| ----------- | ------------------------- |",
      "| Raw editing | **Reversible** and `safe` |",
    ].join("\n"));
    expect(source).toBe("| Capability | Result |\n| --- | --- |\n| Raw editing | Deliberate |");
  });

  test("a whole-cell comment preserves table parsing and anchors to that cell", () => {
    const source = String.raw`| Metric | Value |
| --- | --- |
| ratio | $x^2$ and a\|b |`;
    const state = EditorState.create({ doc: source });
    const model = extractMarkdownTable(state.doc, tableNode(source)!);
    const range = markdownTableCellRange(model!, { section: "body", row: 0, column: 1 });
    const edit = selectionAnnotationEdit(
      source,
      range!.from,
      range!.to,
      "Maya",
      "Check this value",
      "comment",
    );
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;

    const commented =
      source.slice(0, edit.change.from) + edit.change.insert + source.slice(edit.change.to);
    const commentedState = EditorState.create({ doc: commented });
    const commentedNode = tableNode(commented);

    expect(commentedNode).not.toBeNull();
    expect(tablePreviewForNode(commentedState.doc, commentedNode!)).not.toBeNull();
    expect(scanTokens(commented).find((token) => token.type === "comment")).toMatchObject({
      author: "Maya",
      body: "Check this value",
    });
  });

  test("a table-cell comment containing a pipe remains one parseable cell", () => {
    const source = String.raw`| Metric | Value |
| --- | --- |
| ratio | x/y |`;
    const state = EditorState.create({ doc: source });
    const model = extractMarkdownTable(state.doc, tableNode(source)!);
    const range = markdownTableCellRange(model!, { section: "body", row: 0, column: 1 });
    const edit = selectionAnnotationEdit(
      source,
      range!.from,
      range!.to,
      "Maya",
      "Compare x | y",
      "comment",
    );
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;

    const commented =
      source.slice(0, edit.change.from) + edit.change.insert + source.slice(edit.change.to);
    const commentedState = EditorState.create({ doc: commented });
    const commentedNode = tableNode(commented);

    expect(commentedNode).not.toBeNull();
    expect(tablePreviewForNode(commentedState.doc, commentedNode!)).not.toBeNull();
    expect(scanTokens(commented).find((token) => token.type === "comment")).toMatchObject({
      author: "Maya",
      body: "Compare x | y",
    });
  });

  test("Tab and Shift-Tab move through header and body cells without wrapping", () => {
    const model = {
      from: 0,
      to: 0,
      source: "",
      header: ["A", "B"],
      alignments: [null, null],
      rows: [["1", "2"]],
      cellRanges: {
        header: [{ from: 0, to: 0 }, { from: 0, to: 0 }],
        rows: [[{ from: 0, to: 0 }, { from: 0, to: 0 }]],
      },
    };

    expect(nextMarkdownTableCell(model, { section: "header", row: 0, column: 1 }, 1)).toEqual({
      section: "body",
      row: 0,
      column: 0,
    });
    expect(nextMarkdownTableCell(model, { section: "body", row: 0, column: 0 }, -1)).toEqual({
      section: "header",
      row: 0,
      column: 1,
    });
    expect(nextMarkdownTableCell(model, { section: "header", row: 0, column: 0 }, -1)).toBeNull();
    expect(nextMarkdownTableCell(model, { section: "body", row: 0, column: 1 }, 1)).toBeNull();
  });

  test("keeps rows with excess cells raw rather than discarding content", () => {
    const source = "| A | B |\n| --- | --- |\n| one | two | three |";
    const state = EditorState.create({ doc: source });
    const node = tableNode(source);

    expect(node).not.toBeNull();
    expect(extractMarkdownTable(state.doc, node!)).toBeNull();
    expect(state.doc.toString()).toBe(source);
  });

  test("offers an explicit formatter only for a valid table at the cursor", () => {
    const source = "Before\n\nA|B\n---|---:\nx|long value\n\nAfter";
    const state = EditorState.create({
      doc: source,
      extensions: [markdown({ base: markdownLanguage, extensions: [CriticMarkup] })],
    });
    const result = formatMarkdownTableAt(state, source.indexOf("long"));

    expect(result).toEqual({
      status: "changed",
      change: {
        from: source.indexOf("A|B"),
        to: source.indexOf("\n\nAfter"),
        insert: [
          "| A   | B          |",
          "| --- | ---------: |",
          "| x   | long value |",
        ].join("\n"),
      },
    });
    expect(formatMarkdownTableAt(state, 0)).toEqual({ status: "not-table" });

    const formatted = (result as { status: "changed"; change: { insert: string } }).change.insert;
    const formattedState = EditorState.create({
      doc: formatted,
      extensions: [markdown({ base: markdownLanguage, extensions: [CriticMarkup] })],
    });
    expect(formatMarkdownTableAt(formattedState, formatted.indexOf("long"))).toEqual({
      status: "unchanged",
    });
  });
});
