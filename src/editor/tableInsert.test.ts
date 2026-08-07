import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";

import { TABLE_TEMPLATE, tableSlashEdit } from "./tableInsert";
import { CriticMarkup } from "./criticMarkupParser";

function stateAt(doc: string, anchor = doc.length, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdown({ base: markdownLanguage, extensions: [CriticMarkup] })],
  });
}

describe("/table insertion", () => {
  test("replaces a top-level /table line and selects the first header", () => {
    expect(tableSlashEdit(stateAt("/table"))).toEqual({
      from: 0,
      to: 6,
      insert: TABLE_TEMPLATE,
      anchor: 2,
      head: 10,
    });
  });

  test("does not expand /table embedded in prose", () => {
    expect(tableSlashEdit(stateAt("Use /table"))).toBeNull();
  });

  test("does not expand until the cursor reaches the end of the command", () => {
    expect(tableSlashEdit(stateAt("/table", 3))).toBeNull();
  });

  test("does not expand /table inside fenced code", () => {
    const doc = "```md\n/table\n```";
    expect(tableSlashEdit(stateAt(doc, doc.indexOf("/table") + 6))).toBeNull();
  });

  test("does not replace a non-empty selection", () => {
    expect(tableSlashEdit(stateAt("/table", 0, 6))).toBeNull();
  });
});
