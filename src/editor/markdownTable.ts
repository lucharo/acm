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
  cellRanges: {
    header: MarkdownTableCellRange[];
    rows: MarkdownTableCellRange[][];
  };
}

export interface MarkdownTableCellRange {
  from: number;
  to: number;
}

export interface MarkdownTableCellAddress {
  section: "header" | "body";
  row: number;
  column: number;
}

export interface SliceableDocument {
  sliceString(from: number, to: number): string;
}

interface ParsedTableCell extends MarkdownTableCellRange {
  value: string;
}

function splitTableRow(source: string, rowFrom = 0): ParsedTableCell[] {
  const slices: { from: number; to: number }[] = [];
  let cellFrom = 0;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "|" && !escaped) {
      slices.push({ from: cellFrom, to: index });
      cellFrom = index + 1;
    }
    escaped = char === "\\" && !escaped;
  }
  slices.push({ from: cellFrom, to: source.length });

  // Leading/trailing pipes delimit the row rather than introducing cells.
  if (slices.length > 1 && source.slice(slices[0].from, slices[0].to).trim() === "") {
    slices.shift();
  }
  const last = slices.at(-1);
  if (slices.length > 1 && last && source.slice(last.from, last.to).trim() === "") {
    slices.pop();
  }

  // Keep each cell's inline Markdown source intact. Decoding `\|` here loses
  // the escape parity needed to distinguish an escaped pipe from a literal
  // backslash followed by an escaped pipe when the table is serialised again.
  return slices.map((slice) => {
    let from = slice.from;
    let to = slice.to;
    while (from < to && /\s/.test(source[from])) from += 1;
    while (to > from && /\s/.test(source[to - 1])) to -= 1;
    return {
      value: source.slice(from, to),
      from: rowFrom + from,
      to: rowFrom + to,
    };
  });
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

function normaliseRow(cells: ParsedTableCell[], columnCount: number, rowEnd: number): ParsedTableCell[] | null {
  // Never preview a row whose extra cells would be thrown away. Keeping the
  // source visible is safer than presenting a lossy table.
  if (cells.length > columnCount) return null;
  const row = cells.slice(0, columnCount);
  while (row.length < columnCount) row.push({ value: "", from: rowEnd, to: rowEnd });
  return row;
}

function hasUnpreviewableCriticMarkup(node: SyntaxNode): boolean {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (
      child.name === "CMInsert" ||
      child.name === "CMDelete" ||
      child.name === "CMSubstitute" ||
      hasUnpreviewableCriticMarkup(child)
    ) {
      return true;
    }
  }
  return false;
}

function isPreviewEligible(node: SyntaxNode): boolean {
  return (
    node.name === "Table" &&
    node.parent?.name === "Document" &&
    !hasUnpreviewableCriticMarkup(node)
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

  const headerCells = splitTableRow(
    doc.sliceString(headerNode.from, headerNode.to),
    headerNode.from,
  );
  const separator = splitTableRow(
    doc.sliceString(separatorNode.from, separatorNode.to),
    separatorNode.from,
  );
  const header = headerCells.map((cell) => cell.value);
  if (header.length === 0 || separator.length !== header.length) return null;

  const rows: string[][] = [];
  const rowRanges: MarkdownTableCellRange[][] = [];
  for (const rowNode of rowNodes) {
    const row = normaliseRow(
      splitTableRow(doc.sliceString(rowNode.from, rowNode.to), rowNode.from),
      header.length,
      rowNode.to,
    );
    if (!row) return null;
    rows.push(row.map((cell) => cell.value));
    rowRanges.push(row.map(({ from, to }) => ({ from, to })));
  }

  return {
    from: node.from,
    to: node.to,
    source: doc.sliceString(node.from, node.to),
    header,
    alignments: separator.map((cell) => alignmentFromSeparator(cell.value)),
    rows,
    cellRanges: {
      header: headerCells.map(({ from, to }) => ({ from, to })),
      rows: rowRanges,
    },
  };
}

export function markdownTableCellRange(
  model: MarkdownTableModel,
  address: MarkdownTableCellAddress,
): MarkdownTableCellRange | null {
  if (address.column < 0 || address.column >= model.header.length) return null;
  if (address.section === "header") {
    return address.row === 0 ? model.cellRanges.header[address.column] ?? null : null;
  }
  return model.cellRanges.rows[address.row]?.[address.column] ?? null;
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
