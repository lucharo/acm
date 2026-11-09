// Block formatting for the title-bar toolbar: paragraph style (Normal / headings) and
// lists, applied to every line the selection touches. Pure helpers plus thin
// CodeMirror commands, like editor/formatting.ts for bold and italic.
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import type { ChangeSpec, EditorState, Line } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { scanTokens } from "../lib/criticmarkup";

export type BlockStyle = 0 | 1 | 2 | 3; // 0 = normal text
export type ListKind = "bullet" | "number";

const HEADING = /^(#{1,6})[ \t]+/;
const CLOSING_HASHES = /[ \t]+#+[ \t]*$/;
const LIST = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/;

interface TouchedLine {
  from: number;
  text: string;
  /** The caret sits on this (empty) line: format it even though it is blank. */
  caret: boolean;
}

interface Span {
  from: number;
  to: number;
}

function multiLineTokens(state: EditorState): Span[] {
  const text = state.doc.toString();
  return scanTokens(text)
    .filter((token) => text.slice(token.from, token.to).includes("\n"))
    .map(({ from, to }) => ({ from, to }));
}

const startsInside = (spans: Span[], lineFrom: number) =>
  spans.some(({ from, to }) => lineFrom > from && lineFrom < to);

/** Lines the selection touches, except lines that start inside a multi-line
 * CriticMarkup construct (a comment body): a prefix there would split it. */
function touchedLines(state: EditorState): TouchedLine[] {
  const lines = new Map<number, TouchedLine>();
  const inside = multiLineTokens(state);
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    // A selection ending at a line's start (a triple-click, Mod-L) stops at
    // the line before.
    if (!range.empty && last > first && state.doc.line(last).from === range.to) last -= 1;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      if (startsInside(inside, line.from)) continue;
      lines.set(n, { from: line.from, text: line.text, caret: range.empty });
    }
  }
  return [...lines.values()];
}

interface SetextHeading {
  level: 1 | 2;
  /** Where the title text starts, after any quote or list marker. */
  from: number;
  firstLine: number;
  underlineLine: number;
  underlineFrom: number;
}

/** The Setext heading whose title or underline is on the line at `pos`. One that
 * begins or ends inside a multi-line comment is the comment's text, so it is not one. */
function setextHeadingOn(state: EditorState, tree: Tree, pos: number): SetextHeading | null {
  const { doc } = state;
  const line = doc.lineAt(pos);
  const found: SyntaxNode[] = [];
  tree.iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.name === "SetextHeading1" || node.name === "SetextHeading2") found.push(node.node);
    },
  });
  const [heading] = found;
  const underline = heading?.getChild("HeaderMark");
  if (!heading || !underline) return null;
  const firstLine = doc.lineAt(heading.from).number;
  const underlineLine = doc.lineAt(underline.from).number;
  const tokens = multiLineTokens(state);
  if (startsInside(tokens, heading.from) || startsInside(tokens, underline.from)) return null;
  return {
    level: heading.name === "SetextHeading1" ? 1 : 2,
    from: heading.from,
    firstLine,
    underlineLine,
    underlineFrom: underline.from,
  };
}

/** The style of the line holding the main cursor. */
export function currentBlockStyle(state: EditorState): BlockStyle {
  const line = state.doc.lineAt(state.selection.main.head);
  const tree = ensureSyntaxTree(state, line.to);
  const setext = tree && setextHeadingOn(state, tree, line.from);
  if (setext) return setext.level;
  const level = HEADING.exec(line.text)?.[1].length ?? 0;
  return (level > 3 ? 3 : level) as BlockStyle;
}

const formattable = ({ text, caret }: TouchedLine) => caret || text.trim() !== "";

/** Where a continuation line's text starts: past the quote markers the parser
 * read on it, since a `>` in deeper-indented paragraph text is literal. */
function continuationTextStart(tree: Tree, line: Line): number {
  let start = line.from;
  tree.iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.name === "QuoteMark") start = Math.max(start, node.to);
    },
  });
  return start + /^[ \t]*/.exec(line.text.slice(start - line.from))![0].length;
}

/** Where the break after `line` starts: a hard break's backslash or spaces go with it. */
function lineBreakStart(tree: Tree, line: Line): number {
  let start = line.to;
  tree.iterate({
    from: line.to,
    to: line.to,
    enter: (node) => {
      if (node.name === "HardBreak") start = node.from;
    },
  });
  return start;
}

/** Drops the underline. Any other style becomes ATX, the only form with a level 3,
 * and ATX is one line, so a multi-line title is joined, unless a comment spans its
 * lines: that heading stays as it is, since ATX would split the comment across blocks. */
function setextChanges(state: EditorState, tree: Tree, heading: SetextHeading, style: BlockStyle): ChangeSpec[] {
  const { doc } = state;
  const underline = doc.line(heading.underlineLine);
  const lastTitleLine = doc.line(heading.underlineLine - 1);
  if (style === 0) {
    const next = heading.underlineLine < doc.lines ? doc.line(heading.underlineLine + 1) : null;
    // Plain text swallows or reinterprets whatever follows it directly (a rule, an
    // indented code block), so the emptied underline stays as the paragraph boundary.
    const needsBoundary = next !== null && next.text.trim() !== "";
    return [{ from: needsBoundary ? heading.underlineFrom : lastTitleLine.to, to: underline.to, insert: "" }];
  }
  const changes: ChangeSpec[] = [
    { from: lastTitleLine.to, to: underline.to, insert: "" },
    { from: heading.from, insert: `${"#".repeat(style)} ` },
  ];
  const tokens = multiLineTokens(state);
  for (let n = heading.firstLine + 1; n < heading.underlineLine; n++) {
    const line = doc.line(n);
    if (startsInside(tokens, line.from)) return [];
    changes.push({ from: lineBreakStart(tree, doc.line(n - 1)), to: continuationTextStart(tree, line), insert: " " });
  }
  // Unescaped, a trailing hash run would read as the ATX closing marker.
  const closing = CLOSING_HASHES.exec(lastTitleLine.text);
  if (closing) changes.push({ from: lastTitleLine.from + closing.index + closing[0].indexOf("#"), insert: "\\" });
  return changes;
}

export function blockStyleChanges(state: EditorState, style: BlockStyle): ChangeSpec[] {
  const touched = touchedLines(state).filter(formattable);
  const last = touched.at(-1);
  const tree = last ? ensureSyntaxTree(state, last.from + last.text.length) : null;
  if (!tree) return [];
  const handled = new Set<number>();
  return touched.flatMap(({ from, text }) => {
    const setext = setextHeadingOn(state, tree, from);
    if (setext) {
      if (handled.has(setext.from)) return [];
      handled.add(setext.from);
      return setextChanges(state, tree, setext, style);
    }
    const opening = HEADING.exec(text);
    const changes: ChangeSpec[] = [
      { from, to: from + (opening?.[0].length ?? 0), insert: style === 0 ? "" : `${"#".repeat(style)} ` },
    ];
    const closing = opening ? CLOSING_HASHES.exec(text) : null;
    if (closing) changes.push({ from: from + closing.index, to: from + text.length, insert: "" });
    return changes;
  });
}

export function listChanges(state: EditorState, kind: ListKind): ChangeSpec[] {
  const lines = touchedLines(state).filter(formattable);
  const marker = kind === "bullet" ? /^[ \t]*[-*+][ \t]+/ : /^[ \t]*\d{1,9}[.)][ \t]+/;
  const allAlready = lines.length > 0 && lines.every(({ text }) => marker.test(text));
  return lines.map(({ from, text }, index) => {
    const existing = LIST.exec(text);
    const indent = existing?.[1] ?? /^[ \t]*/.exec(text)![0];
    const to = from + (existing?.[0].length ?? indent.length);
    if (allAlready) return { from: from + indent.length, to, insert: "" };
    return { from: from + indent.length, to, insert: kind === "bullet" ? "- " : `${index + 1}. ` };
  });
}

export function setBlockStyle(view: EditorView, style: BlockStyle) {
  view.dispatch({ changes: blockStyleChanges(view.state, style), userEvent: "input.format" });
  view.focus();
}

export function toggleList(view: EditorView, kind: ListKind) {
  view.dispatch({ changes: listChanges(view.state, kind), userEvent: "input.format" });
  view.focus();
}

/** `[label](url)` for `text`, with literal brackets escaped, and the offsets
 * of `url` within it. */
export function linkInsert(text: string): { insert: string; url: [number, number] } {
  const label = (text || "link").replace(/([[\]\\])/g, "\\$1");
  const start = label.length + 3;
  return { insert: `[${label}](url)`, url: [start, start + 3] };
}

/** Wrap the selection as a link and select `url` to type over. */
export function insertLink(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const { insert, url } = linkInsert(view.state.sliceDoc(from, to));
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.single(from + url[0], from + url[1]),
    userEvent: "input.format",
  });
  view.focus();
}
