import type { SyntaxNode } from "@lezer/common";

export type TableAlignment = "left" | "center" | "right" | null;

export interface MarkdownTableModel {
  from: number;
  to: number;
  source: string;
  header: string[];
  alignments: TableAlignment[];
  rows: string[][];
}

export interface SelectionRange {
  from: number;
  to: number;
}

export interface SliceableDocument {
  sliceString(from: number, to: number): string;
}

function splitTableRow(source: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let escaped = false;

  for (const char of source) {
    if (char === "|" && !escaped) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
    escaped = char === "\\" && !escaped;
  }
  cells.push(cell);

  // Leading/trailing pipes delimit the row rather than introducing cells.
  if (cells.length > 1 && cells[0].trim() === "") cells.shift();
  if (cells.length > 1 && cells.at(-1)?.trim() === "") cells.pop();

  return cells.map((value) => value.trim().replace(/\\\|/g, "|"));
}

function alignmentFromSeparator(separator: string): TableAlignment {
  const marker = separator.replace(/\s/g, "");
  const left = marker.startsWith(":");
  const right = marker.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return null;
}

function normaliseRow(cells: string[], columnCount: number): string[] {
  const row = cells.slice(0, columnCount);
  while (row.length < columnCount) row.push("");
  return row;
}

export function extractMarkdownTable(
  doc: SliceableDocument,
  node: SyntaxNode,
): MarkdownTableModel | null {
  if (node.name !== "Table") return null;

  let headerNode: SyntaxNode | null = null;
  let separatorNode: SyntaxNode | null = null;
  const rowNodes: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableHeader") headerNode = child;
    else if (child.name === "TableDelimiter") separatorNode = child;
    else if (child.name === "TableRow") rowNodes.push(child);
  }
  if (!headerNode || !separatorNode) return null;

  const header = splitTableRow(doc.sliceString(headerNode.from, headerNode.to));
  const separator = splitTableRow(doc.sliceString(separatorNode.from, separatorNode.to));
  if (header.length === 0 || separator.length !== header.length) return null;

  return {
    from: node.from,
    to: node.to,
    source: doc.sliceString(node.from, node.to),
    header,
    alignments: separator.map(alignmentFromSeparator),
    rows: rowNodes.map((row) =>
      normaliseRow(splitTableRow(doc.sliceString(row.from, row.to)), header.length),
    ),
  };
}

export function tablePreviewForNode(
  doc: SliceableDocument,
  node: SyntaxNode,
  selections: readonly SelectionRange[],
  hasFocus: boolean,
): MarkdownTableModel | null {
  if (
    hasFocus &&
    selections.some((selection) => selection.to >= node.from && selection.from <= node.to)
  ) {
    return null;
  }
  return extractMarkdownTable(doc, node);
}
