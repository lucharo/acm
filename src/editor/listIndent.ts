import { syntaxTree } from "@codemirror/language";
import type { ChangeSpec, EditorState } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

type Direction = "indent" | "outdent";

interface ListIndentPlan {
  handled: boolean;
  changes: ChangeSpec[];
}

function itemKey(item: SyntaxNode): string {
  return `${item.from}:${item.to}`;
}

/** Markdown continuation content starts after the marker plus its following
 * whitespace. Keep the existing four-space visual indent for bullets and short
 * ordered markers, but widen it when a multi-digit marker needs a later content
 * column (for example `100. ` requires five spaces). */
function listItemIndentUnit(state: EditorState, item: SyntaxNode): number {
  const line = state.doc.lineAt(item.from).text;
  const match = /^[ \t]*(?:[-+*]|\d{1,9}[.)])([ \t]+)/.exec(line);
  if (!match || match[1].includes("\t")) return 4;
  const marker = /^[ \t]*([-+*]|\d{1,9}[.)])/.exec(line)?.[1] ?? "";
  const spacing = match[1].length > 4 ? 1 : match[1].length;
  return Math.max(4, marker.length + spacing);
}

function previousUnselectedSibling(
  item: SyntaxNode,
  selected: ReadonlySet<string>,
): SyntaxNode | null {
  let sibling = item.prevSibling;
  while (sibling?.name === "ListItem" && selected.has(itemKey(sibling))) {
    sibling = sibling.prevSibling;
  }
  return sibling?.name === "ListItem" ? sibling : null;
}

function enclosingListItem(item: SyntaxNode): SyntaxNode | null {
  for (let node = item.parent; node; node = node.parent) {
    if (node.name === "ListItem") return node;
  }
  return null;
}

function listItemAt(state: EditorState, position: number): SyntaxNode | null {
  const line = state.doc.lineAt(position);
  // At a non-empty line's end, a positive bias resolves into the following
  // newline/blank block instead of the item the caret visibly belongs to.
  const probe = position === line.to && position > line.from ? position - 1 : position;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(probe, 1);
  while (node && node.name !== "ListItem") node = node.parent;
  return node;
}

function selectedListItems(state: EditorState): SyntaxNode[] | null {
  const found = new Map<string, SyntaxNode>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const lastPosition = range.empty ? range.head : Math.max(range.from, range.to - 1);
    const last = state.doc.lineAt(lastPosition).number;
    let rangeHadListContent = false;
    for (let number = first; number <= last; number++) {
      const line = state.doc.line(number);
      const nonWhitespace = line.text.search(/\S/);
      if (nonWhitespace < 0) continue;
      const probe = range.empty
        ? range.head
        : Math.max(line.from, Math.min(line.to, line.from + nonWhitespace));
      const item = listItemAt(state, probe);
      if (!item) return null; // a mixed prose/list selection keeps normal Tab focus
      rangeHadListContent = true;
      found.set(itemKey(item), item);
    }
    if (!rangeHadListContent) return null;
  }

  // Selecting a parent row plus one of its nested rows should move the complete
  // parent block once, not indent the child twice.
  const items = [...found.values()].sort((a, b) => a.from - b.from || b.to - a.to);
  return items.filter(
    (item, index) => !items.some((parent, parentIndex) => parentIndex < index && parent.from <= item.from && parent.to >= item.to),
  );
}

export function planListIndent(state: EditorState, direction: Direction): ListIndentPlan {
  const items = selectedListItems(state);
  if (!items) return { handled: false, changes: [] };
  // Markdown only has a valid nesting target when a same-level sibling precedes
  // the first selected item. Four spaces before the first sibling would instead
  // turn it into an indented code block, so keep focus in the editor but do no
  // mutation for that impossible indent.
  if (
    direction === "indent" &&
    items.some((item) => item.prevSibling?.name !== "ListItem")
  ) {
    return { handled: true, changes: [] };
  }

  const lineStarts = new Map<number, string>();
  const selected = new Set(items.map(itemKey));
  for (const item of items) {
    const firstLine = state.doc.lineAt(item.from);
    const leading = firstLine.text.match(/^[ \t]*/)?.[0] ?? "";
    if (direction === "outdent" && leading.length === 0) continue;
    const nestingTarget = previousUnselectedSibling(item, selected) ?? item.prevSibling;
    const indentUnit = direction === "indent" && nestingTarget
      ? listItemIndentUnit(state, nestingTarget)
      : 0;
    const parentItem = direction === "outdent" ? enclosingListItem(item) : null;
    const outdentWidth = parentItem
      ? Math.min(listItemIndentUnit(state, parentItem), leading.length)
      : Math.min(4, leading.length);
    const outdentPrefix = leading.startsWith("\t")
      ? "\t"
      : " ".repeat(outdentWidth);

    for (let number = firstLine.number; number <= state.doc.lineAt(item.to).number; number++) {
      const line = state.doc.line(number);
      if (direction === "indent") {
        if (line.text.trim() === "") continue;
        lineStarts.set(line.from, " ".repeat(indentUnit));
        continue;
      }
      const prefix = outdentPrefix === "\t"
        ? line.text.startsWith("\t") ? "\t" : ""
        : line.text.match(new RegExp(`^ {1,${outdentPrefix.length}}`))?.[0] ?? "";
      if (prefix) lineStarts.set(line.from, prefix);
    }
  }

  const changes: ChangeSpec[] = [...lineStarts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([from, prefix]) =>
      direction === "indent"
        ? { from, insert: prefix }
        : { from, to: from + prefix.length, insert: "" },
    );
  return { handled: true, changes };
}

function run(direction: Direction) {
  return (view: EditorView): boolean => {
    const plan = planListIndent(view.state, direction);
    if (!plan.handled) return false;
    if (plan.changes.length) view.dispatch({ changes: plan.changes });
    return true;
  };
}

/** Tab stays browser focus navigation outside lists; inside a list each action is
 * one CodeMirror transaction, so one undo restores the complete nesting change. */
export const listIndentKeymap: readonly KeyBinding[] = [
  { key: "Tab", run: run("indent") },
  { key: "Shift-Tab", run: run("outdent") },
];
