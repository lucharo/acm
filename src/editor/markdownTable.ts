import type { SyntaxNode } from "@lezer/common";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export type TableAlignment = "left" | "center" | "right" | null;

export interface MarkdownTableModel {
  from: number;
  to: number;
  source: string;
  header: string[];
  alignments: TableAlignment[];
  rows: string[][];
}

export interface MarkdownTableCellAddress {
  section: "header" | "body";
  row: number;
  column: number;
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

  // Keep each cell's inline Markdown source intact. Decoding `\|` here loses
  // the escape parity needed to distinguish an escaped pipe from a literal
  // backslash followed by an escaped pipe when the table is serialised again.
  return cells.map((value) => value.trim());
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

function normaliseRow(cells: string[], columnCount: number): string[] | null {
  // Never preview a row whose extra cells would be thrown away. Keeping the
  // source visible is safer than presenting a lossy table.
  if (cells.length > columnCount) return null;
  const row = cells.slice(0, columnCount);
  while (row.length < columnCount) row.push("");
  return row;
}

function hasCriticMarkup(node: SyntaxNode): boolean {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name.startsWith("CM") || hasCriticMarkup(child)) return true;
  }
  return false;
}

function isPreviewEligible(node: SyntaxNode): boolean {
  return (
    node.name === "Table" &&
    node.parent?.name === "Document" &&
    !hasCriticMarkup(node)
  );
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

  const rows: string[][] = [];
  for (const rowNode of rowNodes) {
    const row = normaliseRow(
      splitTableRow(doc.sliceString(rowNode.from, rowNode.to)),
      header.length,
    );
    if (!row) return null;
    rows.push(row);
  }

  return {
    from: node.from,
    to: node.to,
    source: doc.sliceString(node.from, node.to),
    header,
    alignments: separator.map(alignmentFromSeparator),
    rows,
  };
}

export function tablePreviewForNode(
  doc: SliceableDocument,
  node: SyntaxNode,
): MarkdownTableModel | null {
  // Replacing a container-nested table would discard its quote/list structure,
  // while replacing CriticMarkup would hide its established decorations and
  // controls. Keep both forms raw; only plain top-level tables are previewed.
  if (!isPreviewEligible(node)) return null;
  return extractMarkdownTable(doc, node);
}

function normaliseCellSource(value: string): string {
  return value
    .trim()
    .replace(/\r?\n/g, " ")
    .replace(/\\\|/g, "|")
    .replace(/\|/g, "\\|");
}

function separatorForAlignment(width: number, alignment: TableAlignment): string {
  const target = Math.max(3, width);
  if (alignment === "center") return `:${"-".repeat(Math.max(1, target - 2))}:`;
  if (alignment === "left") return `:${"-".repeat(Math.max(2, target - 1))}`;
  if (alignment === "right") return `${"-".repeat(Math.max(2, target - 1))}:`;
  return "-".repeat(target);
}

/** Return deterministic, aligned GFM source for a parsed table. Formatting is
 * explicit: merely entering or leaving rich preview never changes the buffer. */
export function formatMarkdownTable(model: MarkdownTableModel): string {
  const rows = [model.header, ...model.rows].map((row) =>
    row.map(normaliseCellSource),
  );
  const widths = model.header.map((_, column) =>
    Math.max(3, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const formatRow = (row: string[]) =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  const separator = model.alignments.map((alignment, column) =>
    separatorForAlignment(widths[column], alignment),
  );

  return [formatRow(rows[0]), formatRow(separator), ...rows.slice(1).map(formatRow)].join(
    "\n",
  );
}

/** Apply one rich-cell edit to a cloned semantic model and return the complete
 * table replacement. The caller dispatches that string once, making undo atomic. */
export function updateMarkdownTableCell(
  model: MarkdownTableModel,
  address: MarkdownTableCellAddress,
  value: string,
): string | null {
  const next: MarkdownTableModel = {
    ...model,
    header: [...model.header],
    rows: model.rows.map((row) => [...row]),
  };
  if (address.column < 0 || address.column >= next.header.length) return null;
  if (address.section === "header") {
    if (address.row !== 0) return null;
    next.header[address.column] = value;
  } else {
    const row = next.rows[address.row];
    if (!row) return null;
    row[address.column] = value;
  }
  return formatMarkdownTable(next);
}

/** Resolve keyboard navigation through a rich table without wrapping at either
 * edge, so Tab can return to the browser/editor's normal focus flow. */
export function nextMarkdownTableCell(
  model: MarkdownTableModel,
  current: MarkdownTableCellAddress,
  direction: -1 | 1,
): MarkdownTableCellAddress | null {
  const cells: MarkdownTableCellAddress[] = model.header.map((_, column) => ({
    section: "header",
    row: 0,
    column,
  }));
  model.rows.forEach((row, rowIndex) => {
    row.forEach((_, column) => {
      cells.push({ section: "body", row: rowIndex, column });
    });
  });
  const index = cells.findIndex(
    (cell) =>
      cell.section === current.section &&
      cell.row === current.row &&
      cell.column === current.column,
  );
  if (index < 0) return null;
  return cells[index + direction] ?? null;
}

export type MarkdownTableFormatResult =
  | { status: "not-table" }
  | { status: "unchanged" }
  | { status: "changed"; change: { from: number; to: number; insert: string } };

/** Find the eligible table containing a cursor and prepare an explicit source
 * formatting transaction. Preview toggles never call this function. */
export function formatMarkdownTableAt(
  state: EditorState,
  position: number,
): MarkdownTableFormatResult {
  const safePosition = Math.max(0, Math.min(position, state.doc.length));
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(safePosition, -1);
  while (node && node.name !== "Table") node = node.parent;
  if (!node || safePosition < node.from || safePosition > node.to) {
    return { status: "not-table" };
  }
  const model = tablePreviewForNode(state.doc, node);
  if (!model) return { status: "not-table" };
  const insert = formatMarkdownTable(model);
  if (insert === model.source) return { status: "unchanged" };
  return {
    status: "changed",
    change: { from: model.from, to: model.to, insert },
  };
}
