import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";

import {
  composerAnchorExtension,
  composerAnchorField,
  setComposerAnchor,
} from "./composerAnchor";

function ranges(state: EditorState) {
  const found: Array<{ from: number; to: number; className: string }> = [];
  state.field(composerAnchorField).between(0, state.doc.length, (from, to, value) => {
    found.push({ from, to, className: String(value.spec.class) });
  });
  return found;
}

test("the selected review anchor stays decorated while the composer owns focus", () => {
  let state = EditorState.create({
    doc: "Before selected text after",
    extensions: [composerAnchorExtension],
  });

  state = state.update({ effects: setComposerAnchor.of({ from: 7, to: 20 }) }).state;
  expect(ranges(state)).toEqual([
    { from: 7, to: 20, className: "cm-composer-anchor" },
  ]);

  state = state.update({ changes: { from: 0, insert: "Now " } }).state;
  expect(ranges(state)).toEqual([
    { from: 11, to: 24, className: "cm-composer-anchor" },
  ]);

  state = state.update({ effects: setComposerAnchor.of(null) }).state;
  expect(ranges(state)).toEqual([]);
});
