import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";

import { blockStyleChanges, currentBlockStyle, linkInsert, listChanges } from "./blockFormat";
import type { BlockStyle, ListKind } from "./blockFormat";

function select(doc: string, from: string, to = from) {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(doc.indexOf(from), doc.indexOf(to) + to.length),
  });
}

const styled = (state: EditorState, style: BlockStyle) =>
  state.update({ changes: blockStyleChanges(state, style) }).state.doc.toString();
const listed = (state: EditorState, kind: ListKind) =>
  state.update({ changes: listChanges(state, kind) }).state.doc.toString();

describe("toolbar block formatting (#79)", () => {
  test("paragraph style sets, changes and clears a heading on the cursor's line", () => {
    expect(styled(select("Intro\nBody", "Intro"), 2)).toBe("## Intro\nBody");
    expect(styled(select("# Intro\nBody", "Intro"), 3)).toBe("### Intro\nBody");
    expect(styled(select("## Intro\nBody", "Intro"), 0)).toBe("Intro\nBody");
    expect(currentBlockStyle(select("## Intro", "Intro"))).toBe(2);
  });

  test("a selection ending at the next line's start, and blank lines, are left alone", () => {
    const doc = "Intro\nBody";
    const lineSelected = EditorState.create({ doc, selection: EditorSelection.single(0, 6) });
    expect(styled(lineSelected, 2)).toBe("## Intro\nBody");
    expect(listed(lineSelected, "bullet")).toBe("- Intro\nBody");

    expect(styled(select("One\n\nTwo", "One", "Two"), 1)).toBe("# One\n\n# Two");
  });

  test("the caret on an empty line starts a heading or a list there", () => {
    const empty = EditorState.create({ doc: "One\n\nTwo", selection: EditorSelection.cursor(4) });
    expect(styled(empty, 2)).toBe("One\n## \nTwo");
    expect(listed(empty, "bullet")).toBe("One\n- \nTwo");
  });

  test("a closing hash run goes with the heading; indentation stays before a new marker", () => {
    expect(styled(select("# Title #\nBody", "Title"), 0)).toBe("Title\nBody");
    expect(listed(select("- parent\n  child", "child"), "bullet")).toBe("- parent\n  - child");
  });

  test("lines inside a multi-line comment are never formatted", () => {
    const doc = "Before {>>@a: note\nmore<<} after";
    expect(styled(select(doc, "Before", "after"), 1)).toBe("# Before {>>@a: note\nmore<<} after");
    expect(listed(select(doc, "Before", "after"), "bullet")).toBe("- Before {>>@a: note\nmore<<} after");
  });

  test("a link label keeps literal brackets as text", () => {
    expect(linkInsert("x[y]z")).toEqual({ insert: "[x\\[y\\]z](url)", url: [10, 13] });
  });

  test("lists apply to every selected line and toggle off when all already are", () => {
    expect(listed(select("one\ntwo\n\nlater", "one", "two"), "number")).toBe("1. one\n2. two\n\nlater");
    expect(listed(select("- one\n- two", "one", "two"), "bullet")).toBe("one\ntwo");
    expect(listed(select("1. one\n2. two", "one", "two"), "bullet")).toBe("- one\n- two");
  });
});
