import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/** The two-column table inserted by the `/table` completion. */
export const TABLE_TEMPLATE = "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |";

export interface TableSlashEdit {
  from: number;
  to: number;
  insert: string;
  anchor: number;
  head: number;
}

function isInsideCode(state: EditorState, position: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, -1);
  while (node) {
    if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "InlineCode") {
      return true;
    }
    node = node.parent;
  }
  return false;
}

/** Return the `/table` replacement for the active line, or null when inapplicable. */
export function tableSlashEdit(state: EditorState): TableSlashEdit | null {
  if (state.selection.ranges.some((range) => !range.empty)) return null;

  const position = state.selection.main.head;
  const line = state.doc.lineAt(position);
  if (
    position !== line.to ||
    line.text !== "/table" ||
    isInsideCode(state, position)
  ) {
    return null;
  }

  return {
    from: line.from,
    to: line.to,
    insert: TABLE_TEMPLATE,
    anchor: line.from + 2,
    head: line.from + 10,
  };
}

function insertTable(view: EditorView): boolean {
  const edit = tableSlashEdit(view.state);
  if (!edit) return false;
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.anchor, head: edit.head },
    userEvent: "input.complete",
  });
  return true;
}

/** Must be installed before CodeMirror's defaults so it owns Enter on `/table`. */
export const tableSlashKeymap: readonly KeyBinding[] = [{ key: "Enter", run: insertTable }];
