import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import {
  standaloneInsertionPreviews,
  standaloneInsertionTokens,
  standaloneInsertionTokensField,
} from "./standaloneInsertion";
import { standaloneInsertionPresentation } from "./criticMarkupView";
import { documentPreviewExtension } from "./previewMode";

describe("standalone insertion previews", () => {
  test("rich additions keep review actions in the comment rail", () => {
    expect(standaloneInsertionPresentation()).toEqual({
      label: "Added",
      actionSurface: "rail",
    });
  });

  test("rich mode exposes block additions while inline additions keep their existing path", () => {
    const inner = "### Glossary\n\n- **Agent**\n- [ACM](https://example.com)";
    const content = `Before\n{++${inner}++}\nAfter {++inline++}.`;

    const rich = standaloneInsertionPreviews(content);

    expect(rich).toEqual([
      expect.objectContaining({
        type: "insert",
        from: content.indexOf("{++"),
        inner,
        raw: `{++${inner}++}`,
      }),
    ]);
  });

  test("all preview layers reuse one token list until the document changes", () => {
    const doc = "Before\n\n{++## Added++}\n";
    const state = EditorState.create({
      doc,
      extensions: [documentPreviewExtension(true)],
    });
    const initial = state.field(standaloneInsertionTokensField);

    const selectionOnly = state.update({ selection: { anchor: 0 } }).state;
    expect(selectionOnly.field(standaloneInsertionTokensField)).toBe(initial);

    const edited = selectionOnly.update({
      changes: { from: selectionOnly.doc.length, insert: "After\n" },
    }).state;
    expect(edited.field(standaloneInsertionTokensField)).not.toBe(initial);
    expect(edited.field(standaloneInsertionTokensField)).toEqual(initial);
  });

  test("preview layers cannot silently fall back to repeated document scans", () => {
    const stateWithoutPreviewCache = EditorState.create({ doc: "{++Added++}" });

    expect(() => standaloneInsertionTokens(stateWithoutPreviewCache)).toThrow(
      "Field is not present in this state",
    );
  });
});
