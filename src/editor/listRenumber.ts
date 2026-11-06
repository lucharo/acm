// ── Ordered-list renumbering (#80) ────────────────────────────────────────────
// After a local edit deletes, moves, inserts or accepts a list item, the ordered
// lists it touched get consecutive labels again, in the style each list already
// uses: 1. 2. 3., a. b. c., A. B. C., i. ii. iii., I. II. III. Each nesting level
// is its own list. The renumbering rides in the SAME transaction (a transaction
// filter), so one undo restores both the edit and the old labels.
//
// Lettered and roman lists are not lists to CommonMark (Lezer parses them as
// paragraph text), so items are found by a line scan, not the syntax tree; the
// tree is consulted only to leave code blocks alone. Remote/agent snapshots
// (Transaction.remote) are never renumbered; undo/redo bypass filters.

import { GFM, parser as baseMarkdownParser } from "@lezer/markdown";
import { EditorState, Transaction } from "@codemirror/state";
import type { ChangeSpec, Extension, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { scanTokens } from "../lib/criticmarkup";

type Style = "decimal" | "lower-alpha" | "upper-alpha" | "lower-roman" | "upper-roman";

interface Item {
  line: number;
  labelFrom: number;
  labelTo: number;
  label: string;
}

interface Run {
  indent: number;
  delimiter: string;
  family: "digit" | "lower" | "upper";
  items: Item[];
  /** Some line inside the list is indented deeper than its markers (a nested
   * list or a continuation), so a label changing width would break nesting. */
  nested: boolean;
}

// A label is digits, ONE letter, or a valid multi-letter roman numeral: a
// capitalised word ending a sentence ("Note.", "Also.") is never a label.
const MARKER = /^([ \t]*)(\d{1,9}|[a-zA-Z]|[ivxlcdm]{2,15}|[IVXLCDM]{2,15})([.)])(?=[ \t]|$)/;
const ROMAN = /^(m{0,3})(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;
// A line that starts another block ends every list at its indent or deeper,
// even with no blank line before it.
const BLOCK_START =
  /^[ \t]*(#{1,6}([ \t]|$)|[-*+][ \t]|>|```|~~~|(\*[ \t]*){3,}$|(-[ \t]*){3,}$|(_[ \t]*){3,}$)/;
const LITERAL_BLOCKS = new Set([
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "CommentBlock",
  "ProcessingInstructionBlock",
  "Table", // a table needs its delimiter row; a lone leading pipe is prose
  "InlineCode", // may span lines inside a paragraph
]);

/** Markdown column of a line's first non-blank character (tabs stop every 4). */
function indentColumn(text: string): number {
  let column = 0;
  for (const char of text) {
    if (char === " ") column += 1;
    else if (char === "\t") column += 4 - (column % 4);
    else return column;
  }
  return -1;
}

function markerAt(text: string): RegExpExecArray | null {
  const match = MARKER.exec(text);
  if (!match) return null;
  const label = match[2];
  if (label.length > 1 && !/^\d/.test(label) && !ROMAN.test(label)) return null;
  return match;
}

interface Span {
  from: number;
  to: number;
}

/** CriticMarkup that matters to lists. `comments`: numbered lines inside a
 * comment body are its text, not document items. `blocks`: a change or
 * highlight that starts a line or spans lines may wrap an item's marker or
 * carry proposed items, so a list it touches waits until it is resolved. */
function critRanges(doc: Text): { comments: Span[]; blocks: Span[] } {
  const text = doc.toString();
  const comments: Span[] = [];
  const blocks: Span[] = [];
  for (const token of scanTokens(text)) {
    if (token.type === "comment") comments.push({ from: token.from, to: token.to });
    else if (
      text.slice(token.from, token.to).includes("\n") ||
      /^[ \t]*$/.test(text.slice(doc.lineAt(token.from).from, token.from))
    ) {
      blocks.push({ from: token.from, to: token.to });
    }
  }
  return { comments, blocks };
}

function family(label: string): Run["family"] {
  if (/^\d/.test(label)) return "digit";
  return label === label.toLowerCase() ? "lower" : "upper";
}

const markdownParser = baseMarkdownParser.configure(GFM);

/** Code (fenced, indented, inline), tables, HTML, HTML-comment and
 * processing-instruction regions, from a full
 * parse of the text. CodeMirror's own tree may be partial (it parses toward
 * the viewport), so it cannot say whether a far line sits in a code block. */
function literalBlocks(text: string): Span[] {
  const blocks: Span[] = [];
  markdownParser.parse(text).iterate({
    enter(node) {
      if (!LITERAL_BLOCKS.has(node.name)) return undefined;
      blocks.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return blocks;
}

/** Every ordered run in the document, one per list per nesting level. */
function scanRuns(doc: Text, comments: Span[]): Run[] {
  const literals = literalBlocks(doc.toString());
  const inLiteral = (pos: number) => literals.some((block) => pos >= block.from && pos < block.to);
  const runs: Run[] = [];
  let open: Run[] = []; // innermost last
  let previousBlank = true;
  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number);
    const indent = indentColumn(line.text);
    if (indent < 0) {
      previousBlank = true;
      continue;
    }
    // A comment body is not document text: skip its lines without ending or
    // extending any list.
    if (comments.some((range) => line.from >= range.from && line.from < range.to)) continue;
    for (const run of open) if (run.indent < indent) run.nested = true;
    const match = markerAt(line.text);
    const literal = inLiteral(line.from + (match ? match[1].length : 0));
    if (match && !literal) {
      const label = match[2];
      const delimiter = match[3];
      open = open.filter((run) => run.indent <= indent);
      const current = open.at(-1);
      const item: Item = {
        line: number,
        labelFrom: line.from + match[1].length,
        labelTo: line.from + match[1].length + label.length,
        label,
      };
      if (
        current &&
        current.indent === indent &&
        current.delimiter === delimiter &&
        current.family === family(label)
      ) {
        current.items.push(item);
      } else {
        if (current?.indent === indent) open.pop();
        const run: Run = {
          indent,
          delimiter,
          family: family(label),
          items: [item],
          nested: false,
        };
        runs.push(run);
        open.push(run);
      }
    } else if (previousBlank || literal || BLOCK_START.test(line.text)) {
      // A paragraph after a blank line, or any other block, ends every list it
      // is not nested in; a plain line straight after an item is a lazy
      // continuation and ends nothing.
      open = open.filter((run) => run.indent < indent);
    }
    previousBlank = false;
  }
  return runs;
}

/** Roman or alphabetic? A multi-letter label can only be roman (v. vi. vii.);
 * a letter that is no roman digit only alphabetic (c. d. e.); a run of single
 * roman letters is roman only when it starts at i. */
function styleOf(run: Run): Style {
  if (run.family === "digit") return "decimal";
  const labels = run.items.map((item) => item.label.toLowerCase());
  const roman = labels.some((label) => label.length > 1) ||
    (labels[0] === "i" && labels.every((label) => ROMAN.test(label)));
  if (roman) return run.family === "lower" ? "lower-roman" : "upper-roman";
  return run.family === "lower" ? "lower-alpha" : "upper-alpha";
}

const ROMAN_DIGITS: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

function toRoman(n: number): string {
  let out = "";
  for (const [value, digits] of ROMAN_DIGITS) {
    while (n >= value) {
      out += digits;
      n -= value;
    }
  }
  return out;
}

function fromRoman(label: string): number {
  let total = 0;
  let rest = label.toLowerCase();
  for (const [value, digits] of ROMAN_DIGITS) {
    while (rest.startsWith(digits)) {
      total += value;
      rest = rest.slice(digits.length);
    }
  }
  return total;
}

/** Bijective base 26: a…z, aa…az, … */
function toAlpha(n: number): string {
  let out = "";
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function fromAlpha(label: string): number {
  let n = 0;
  for (const char of label.toLowerCase()) n = n * 26 + (char.charCodeAt(0) - 96);
  return n;
}

function valueOf(label: string, style: Style): number {
  if (style === "decimal") return Number.parseInt(label, 10);
  if (style.endsWith("roman")) return fromRoman(label);
  return fromAlpha(label);
}

function labelFor(value: number, style: Style): string {
  if (style === "decimal") return String(value);
  const lower = style.endsWith("roman") ? toRoman(value) : toAlpha(value);
  return style.startsWith("upper") ? lower.toUpperCase() : lower;
}

function runAtLine(runs: Run[], line: number, indent: number): Run | undefined {
  return runs.find((run) => run.indent === indent && run.items.some((item) => item.line === line));
}

/** True when the user typed or deleted INSIDE the first item's label: that
 * edit sets where the list starts (changing `1.` to `5.` must stick). */
function editedFirstLabel(tr: Transaction, first: Item): boolean {
  if (!tr.isUserEvent("input") && !tr.isUserEvent("delete")) return false;
  let edited = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (fromB < toB) {
      // Typed or pasted label characters into the label (a pasted item carries
      // its line break and is not a label edit).
      if (fromB < first.labelTo && toB > first.labelFrom && /^[0-9a-zA-Z]+$/.test(inserted.toString())) {
        edited = true;
      }
    } else if (fromB >= first.labelFrom && fromB <= first.labelTo) {
      // Deleted label characters only (a whole deleted item carries its line
      // break or text, and is not a label edit).
      if (/^[0-9a-zA-Z]+$/.test(tr.startState.doc.sliceString(fromA, toA))) edited = true;
    }
  });
  return edited;
}

/** The label changes that make every touched ordered list consecutive again. */
export function planListRenumber(tr: Transaction): ChangeSpec[] {
  if (!tr.docChanged || tr.annotation(Transaction.remote)) return [];

  const doc: Text = tr.newDoc;
  const touched = new Set<number>();
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const first = doc.lineAt(fromB).number;
    const last = doc.lineAt(toB).number;
    for (let number = Math.max(1, first - 1); number <= Math.min(doc.lines, last + 1); number++) {
      touched.add(number);
    }
  });
  if (![...touched].some((number) => MARKER.test(doc.line(number).text))) return [];

  const crit = critRanges(doc);
  const runs = scanRuns(doc, crit.comments).filter((run) => {
    const firstLine = run.items[0].line;
    const lastLine = run.items[run.items.length - 1].line;
    // The lines either side count: a highlight wrapping the first or last item
    // hides its marker, so the run seems to start later or end earlier.
    const from = doc.line(Math.max(1, firstLine - 1)).from;
    const to = doc.line(Math.min(doc.lines, lastLine + 1)).to;
    return (
      !crit.blocks.some((block) => block.from <= to && block.to >= from) &&
      [...touched].some((number) => number >= firstLine && number <= lastLine)
    );
  });
  if (runs.length === 0) return [];

  const back = tr.changes.invert(tr.startState.doc);
  const inserted: { from: number; to: number }[] = [];
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB) inserted.push({ from: fromB, to: toB });
  });
  const isInserted = (item: Item) =>
    inserted.some((range) => doc.line(item.line).from >= range.from && item.labelTo <= range.to);
  let oldRuns: Run[] | null = null;
  const changes: ChangeSpec[] = [];
  for (const run of runs) {
    const first = run.items[0];
    let style = styleOf(run);
    let start = valueOf(first.label, style);
    // A list that arrived whole (pasted, accepted) keeps the labels it came with.
    if (!editedFirstLabel(tr, first) && !run.items.every(isInserted)) {
      // Keep the list's original start and style: map its first line back to
      // the document before this edit and read the list that was there.
      oldRuns ??= scanRuns(tr.startState.doc, critRanges(tr.startState.doc).comments);
      const oldPos = back.mapPos(doc.line(first.line).from, 1);
      const oldLine = tr.startState.doc.lineAt(oldPos).number;
      const before = runAtLine(oldRuns, oldLine, run.indent);
      if (before && before.delimiter === run.delimiter && before.family === run.family) {
        style = styleOf(before);
        start = valueOf(before.items[0].label, style);
      }
    }
    // Past z a letter label would be one this scanner cannot read back.
    if (style.endsWith("alpha") && start + run.items.length - 1 > 26) continue;
    const labels = run.items.map((_item, index) => labelFor(start + index, style));
    // A wider or narrower label would shift the content column its nested
    // lines are indented to; leave such a list for the writer to fix.
    if (run.nested && run.items.some((item, index) => labels[index].length !== item.label.length)) {
      continue;
    }
    run.items.forEach((item, index) => {
      if (labels[index] !== item.label) {
        changes.push({ from: item.labelFrom, to: item.labelTo, insert: labels[index] });
      }
    });
  }
  return changes;
}

/** `isDecision` marks a review decision's transaction (accept, reject, apply):
 * its audit event records offsets in that transaction's result, so the
 * renumbering follows in a transaction of its own instead of widening it. */
export function listRenumber(isDecision: (tr: Transaction) => boolean): Extension {
  return [
    EditorState.transactionFilter.of((tr) => {
      if (isDecision(tr)) return tr;
      const changes = planListRenumber(tr);
      return changes.length ? [tr, { changes, sequential: true }] : tr;
    }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || !update.transactions.some(isDecision)) return;
      // filter: false, or this extension's own filter would renumber the replay.
      const replay = update.startState.update({ changes: update.changes, filter: false });
      const changes = planListRenumber(replay);
      if (changes.length === 0) return;
      const doc = update.state.doc;
      // A view may not dispatch during its own update. Kept out of history:
      // undoing the decision restores its markup, which holds the list until
      // it is resolved again, and that resolution renumbers once more.
      queueMicrotask(() => {
        if (update.view.state.doc !== doc) return;
        update.view.dispatch({
          changes,
          userEvent: "input.renumber",
          annotations: Transaction.addToHistory.of(false),
        });
      });
    }),
  ];
}
