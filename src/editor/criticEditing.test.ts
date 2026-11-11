import { describe, expect, test } from "bun:test";
import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import { CriticMarkup } from "./criticMarkupParser";
import { documentPreviewExtension } from "./previewMode";

// bun:test has no DOM, so the editor is a stand-in that inherits EditorView's
// prototype (CodeMirror's delete commands only skip atomic ranges for a real
// EditorView) and carries the state, dispatch and viewport they read.
interface FakeView {
  state: EditorState;
}

function editor(doc: string, cursor: number | { anchor: number; head: number }, rich = true): FakeView {
  const selection =
    typeof cursor === "number"
      ? EditorSelection.cursor(cursor)
      : EditorSelection.range(cursor.anchor, cursor.head);
  const state = EditorState.create({
    doc,
    selection,
    extensions: [
      keymap.of(defaultKeymap),
      markdown({ base: markdownLanguage, extensions: [CriticMarkup] }),
      documentPreviewExtension(rich),
    ],
  });
  const view = Object.create(EditorView.prototype) as FakeView & {
    visibleRanges: Array<{ from: number; to: number }>;
  };
  Object.defineProperty(view, "state", { value: state, writable: true });
  Object.defineProperty(view, "visibleRanges", {
    get: () => [{ from: 0, to: view.state.doc.length }],
  });
  Object.defineProperty(view, "dispatch", {
    value: (spec: Transaction | TransactionSpec) => {
      view.state = spec instanceof Transaction ? spec.state : view.state.update(spec).state;
    },
  });
  return view;
}

// Run the key the way CodeMirror's keymap handler does: bindings in precedence
// order, first one that returns true wins. Keys use the macOS spelling.
function press(view: FakeView, key: string): boolean {
  for (const bindings of view.state.facet(keymap)) {
    for (const binding of bindings) {
      const name = binding.mac ?? binding.key;
      if (name === key && binding.run?.(view as unknown as EditorView)) return true;
    }
  }
  return false;
}

function type(view: FakeView, text: string): void {
  const { from, to } = view.state.selection.main;
  const tr = view.state.update({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + text.length),
    userEvent: "input.type",
  });
  view.state = tr.state;
}

// The text CodeMirror puts on the clipboard or in a drag for the selection.
function copied(view: FakeView): string {
  const { from, to } = view.state.selection.main;
  return view.state
    .facet(EditorView.clipboardOutputFilter)
    .reduce((text, filter) => filter(text, view.state), view.state.sliceDoc(from, to));
}

function after(doc: string, needle: string): number {
  const at = doc.indexOf(needle);
  if (at < 0) throw new Error(`fixture lacks ${needle}`);
  return at + needle.length;
}

function before(doc: string, needle: string): number {
  const at = doc.indexOf(needle);
  if (at < 0) throw new Error(`fixture lacks ${needle}`);
  return at;
}

const COMMENTED = "See {==word==}{>>@luis: note<<} here";

describe("deleting at the visible edge of a commented word", () => {
  test("Backspace after the comment marker deletes the word's last letter, not the comment", () => {
    const view = editor(COMMENTED, after(COMMENTED, "<<}"));

    press(view, "Backspace");

    expect(view.state.doc.toString()).toBe("See {==wor==}{>>@luis: note<<} here");
    expect(view.state.selection.main.head).toBe(after("See {==wor", "wor"));
  });

  test("Backspace at the start of a highlighted word deletes the character before it", () => {
    const view = editor(COMMENTED, after(COMMENTED, "{=="));

    press(view, "Backspace");

    expect(view.state.doc.toString()).toBe("See{==word==}{>>@luis: note<<} here");
  });

  test("Delete before the opening delimiter deletes the word's first letter", () => {
    const view = editor(COMMENTED, before(COMMENTED, "{=="));

    press(view, "Delete");

    expect(view.state.doc.toString()).toBe("See {==ord==}{>>@luis: note<<} here");
  });

  test("Delete at the end of the word deletes the character after the comment marker", () => {
    const view = editor(COMMENTED, before(COMMENTED, "==}"));

    press(view, "Delete");

    expect(view.state.doc.toString()).toBe("See {==word==}{>>@luis: note<<}here");
    expect(view.state.selection.main.head).toBe(before(COMMENTED, "==}"));
  });

  test("the macOS Ctrl-H alias behaves like Backspace", () => {
    const view = editor(COMMENTED, after(COMMENTED, "<<}"));

    press(view, "Ctrl-h");

    expect(view.state.doc.toString()).toBe("See {==wor==}{>>@luis: note<<} here");
  });

  test("Backspace at the start of the document leaves the markup alone", () => {
    const doc = "{==word==}{>>@luis: note<<}";
    const view = editor(doc, after(doc, "{=="));

    press(view, "Backspace");

    expect(view.state.doc.toString()).toBe(doc);
  });

  test("Option-Backspace after the marker deletes the word and keeps the comment as a point comment", () => {
    const view = editor(COMMENTED, after(COMMENTED, "<<}"));

    press(view, "Alt-Backspace");

    expect(view.state.doc.toString()).toBe("See {>>@luis: note<<} here");
  });

  test("Backspace on a one-letter commented word keeps the comment as a point comment", () => {
    const doc = "A {==x==}{>>@luis: note<<} b";
    const view = editor(doc, after(doc, "<<}"));

    press(view, "Backspace");

    expect(view.state.doc.toString()).toBe("A {>>@luis: note<<} b");
    expect(view.state.selection.main.head).toBe(2);
  });

  test("Backspace after a suggested insertion deletes its last letter", () => {
    const doc = "A {++abc++} b";
    const view = editor(doc, after(doc, "++}"));

    press(view, "Backspace");

    expect(view.state.doc.toString()).toBe("A {++ab++} b");
  });

  test("Backspace on a one-letter suggested insertion removes the empty suggestion", () => {
    const doc = "A {++c++} b";
    const view = editor(doc, after(doc, "++}"));

    press(view, "Backspace");

    expect(view.state.doc.toString()).toBe("A  b");
  });

  test("Backspace at the start of a list item that opens with a highlight removes the list marker", () => {
    const doc = "- {==w==}{>>@a: x<<} z";
    const view = editor(doc, after(doc, "{=="));

    press(view, "Backspace");

    expect(view.state.doc.toString()).toBe("{==w==}{>>@a: x<<} z");
  });

  test("source mode keeps raw Backspace: the closing brace goes", () => {
    const view = editor(COMMENTED, after(COMMENTED, "<<}"), false);

    press(view, "Backspace");

    expect(view.state.doc.toString()).toBe("See {==word==}{>>@luis: note<< here");
  });
});

describe("other edits that cross hidden markup", () => {
  test("deleting a selection from inside the word to past the marker keeps the delimiter and comment", () => {
    const view = editor(COMMENTED, { anchor: after(COMMENTED, "{==wo"), head: after(COMMENTED, "<<} he") });

    press(view, "Backspace");

    expect(view.state.doc.toString()).toBe("See {==wo==}{>>@luis: note<<}re");
  });

  test("deleting a selection that covers the whole commented word removes word and comment", () => {
    const view = editor(COMMENTED, { anchor: before(COMMENTED, "{=="), head: after(COMMENTED, "<<}") });

    press(view, "Backspace");

    expect(view.state.doc.toString()).toBe("See  here");
  });

  test("typing over a selection that starts before the word keeps the opening delimiter", () => {
    const view = editor(COMMENTED, { anchor: after(COMMENTED, "Se"), head: after(COMMENTED, "{==wo") });

    type(view, "X");

    expect(view.state.doc.toString()).toBe("SeX{==rd==}{>>@luis: note<<} here");
    expect(view.state.selection.main.head).toBe(3);
  });

  test("selecting the comment marker and pressing Backspace deletes the comment, keeping the highlight", () => {
    const view = editor(COMMENTED, { anchor: before(COMMENTED, "==}"), head: after(COMMENTED, "<<}") });

    press(view, "Backspace");

    expect(view.state.doc.toString()).toBe("See {==word==} here");
  });

  test("dragging part of a commented word elsewhere moves only its visible text", () => {
    const doc = COMMENTED + ". Tail";
    const from = after(doc, "{==wo");
    const to = after(doc, "<<} he");
    const view = editor(doc, { anchor: from, head: to });

    const dragged = copied(view);
    view.state = view.state.update({
      changes: [{ from, to }, { from: doc.length, insert: dragged }],
      selection: EditorSelection.range(doc.length - (to - from), doc.length - (to - from) + dragged.length),
      userEvent: "move.drop",
    }).state;

    const text = view.state.doc.toString();
    expect(text).toBe("See {==wo==}{>>@luis: note<<}re. Tailrd he");
    const { from: selFrom, to: selTo } = view.state.selection.main;
    expect(text.slice(selFrom, selTo)).toBe("rd he");
  });

  test("emptying a nested commented word keeps both comments as point comments", () => {
    const doc = "A {=={==x==}{>>@a: note<<}==}{>>@b: reply<<} b";
    const view = editor(doc, after(doc, "{=={==x"));

    press(view, "Backspace");

    expect(view.state.doc.toString()).toBe("A {>>@a: note<<}{>>@b: reply<<} b");
    expect(view.state.selection.main.head).toBe(2);
  });

  test("cutting part of a commented word puts only its visible text on the clipboard", () => {
    const view = editor(COMMENTED, { anchor: after(COMMENTED, "{==wo"), head: after(COMMENTED, "<<} he") });

    const clipboard = copied(view);
    const { from, to } = view.state.selection.main;
    view.state = view.state.update({ changes: { from, to }, userEvent: "delete.cut" }).state;

    expect(clipboard).toBe("rd he");
    expect(view.state.doc.toString()).toBe("See {==wo==}{>>@luis: note<<}re");
  });

  test("copying a whole commented word keeps its markup", () => {
    const view = editor(COMMENTED, { anchor: before(COMMENTED, "{=="), head: after(COMMENTED, "<<}") });

    expect(copied(view)).toBe("{==word==}{>>@luis: note<<}");
  });

  test("Enter over a selection that crosses the comment keeps the markup", () => {
    const view = editor(COMMENTED, { anchor: after(COMMENTED, "{==wo"), head: after(COMMENTED, "<<} he") });

    view.state = view.state.update(view.state.replaceSelection("\n"), { userEvent: "input" }).state;

    expect(view.state.doc.toString()).toBe("See {==wo\n==}{>>@luis: note<<}re");
  });

  test("an edit with no user event (an accept, a remote write) passes through untouched", () => {
    const view = editor(COMMENTED, 0);
    const from = before(COMMENTED, "==}");

    view.state = view.state.update({ changes: { from, to: from + 3 } }).state;

    expect(view.state.doc.toString()).toBe("See {==word{>>@luis: note<<} here");
  });

  test("the caret cannot rest between a highlight's closing delimiter and its comment", () => {
    const view = editor(COMMENTED, 0) as FakeView & { visibleRanges: Array<{ from: number; to: number }> };
    const spans: Array<{ from: number; to: number }> = [];
    for (const provider of view.state.facet(EditorView.atomicRanges)) {
      provider(view as unknown as EditorView).between(0, view.state.doc.length, (from, to) => {
        spans.push({ from, to });
      });
    }

    expect(spans).toEqual([
      { from: before(COMMENTED, "{=="), to: after(COMMENTED, "{==") },
      { from: before(COMMENTED, "==}"), to: after(COMMENTED, "<<}") },
    ]);
  });
});
