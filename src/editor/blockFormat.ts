// Block formatting for the title-bar toolbar: paragraph style (Normal / headings) and
// lists, applied to every line the selection touches. Pure helpers plus thin
// CodeMirror commands, like editor/formatting.ts for bold and italic.
import { EditorSelection } from "@codemirror/state";
import type { ChangeSpec, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
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

/** Lines the selection touches, except lines that start inside a multi-line
 * CriticMarkup construct (a comment body): a prefix there would split it. */
function touchedLines(state: EditorState): TouchedLine[] {
  const lines = new Map<number, TouchedLine>();
  const text = state.doc.toString();
  const inside = scanTokens(text)
    .filter((token) => text.slice(token.from, token.to).includes("\n"))
    .map(({ from, to }) => ({ from, to }));
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    // A selection ending at a line's start (a triple-click, Mod-L) stops at
    // the line before.
    if (!range.empty && last > first && state.doc.line(last).from === range.to) last -= 1;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      if (inside.some((span) => line.from > span.from && line.from < span.to)) continue;
      lines.set(n, { from: line.from, text: line.text, caret: range.empty });
    }
  }
  return [...lines.values()];
}

/** The style of the line holding the main cursor. */
export function currentBlockStyle(state: EditorState): BlockStyle {
  const line = state.doc.lineAt(state.selection.main.head).text;
  const level = HEADING.exec(line)?.[1].length ?? 0;
  return (level > 3 ? 3 : level) as BlockStyle;
}

const formattable = ({ text, caret }: TouchedLine) => caret || text.trim() !== "";

export function blockStyleChanges(state: EditorState, style: BlockStyle): ChangeSpec[] {
  return touchedLines(state).filter(formattable).flatMap(({ from, text }) => {
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
