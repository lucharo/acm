import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { CriticMarkup } from "./criticMarkupParser";
import { documentPreviewExtension } from "./previewMode";

function atomicSpans(state: EditorState): Array<{ from: number; to: number }> {
  const view = {
    state,
    visibleRanges: [{ from: 0, to: state.doc.length }],
  } as unknown as EditorView;
  const spans: Array<{ from: number; to: number }> = [];
  for (const provider of state.facet(EditorView.atomicRanges)) {
    provider(view).between(0, state.doc.length, (from, to) => {
      spans.push({ from, to });
    });
  }
  return spans;
}

function editorState(doc: string, richPreview = true): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [CriticMarkup] }),
      documentPreviewExtension(richPreview),
    ],
  });
}

describe("rich block preview cursor boundaries", () => {
  test("a rich table is one atomic keyboard range", () => {
    const doc = "Before\n\n| Name | Value |\n| --- | --- |\n| Tea | *hot* |\n\nAfter";
    const from = doc.indexOf("| Name");
    const to = doc.indexOf("\n\nAfter");

    expect(atomicSpans(editorState(doc))).toContainEqual({ from, to });
  });

  test("the global source mode removes table and addition replacements without changing text", () => {
    const doc = "Before\n\n{++## Added\n\n- **one**\n- two++}\n\nAfter";
    const from = doc.indexOf("{++");
    const to = doc.indexOf("++}") + 3;
    const rich = editorState(doc);
    const raw = editorState(doc, false);

    expect(atomicSpans(rich)).toContainEqual({ from, to });
    expect(atomicSpans(raw)).not.toContainEqual({ from, to });
    expect(raw.doc.toString()).toBe(doc);
  });

  test("safe HTML blocks use the same deliberate global raw escape", () => {
    const doc = [
      "Before",
      "",
      "<table>",
      "<tr><td><ul><li>Left</li></ul></td><td><ul><li>Right</li></ul></td></tr>",
      "</table>",
      "",
      "After",
    ].join("\n");
    const from = doc.indexOf("<table>");
    const to = doc.indexOf("\n\nAfter");

    expect(atomicSpans(editorState(doc))).toContainEqual({ from, to });
    expect(atomicSpans(editorState(doc, false))).not.toContainEqual({ from, to });
  });

  test("fenced code renders as one rich block with the global raw escape", () => {
    const doc = "Before\n\n```ts\nconst value = 1;\n```\n\nAfter";
    const from = doc.indexOf("```ts");
    const to = doc.indexOf("\n\nAfter");

    expect(atomicSpans(editorState(doc))).toContainEqual({ from, to });
    expect(atomicSpans(editorState(doc, false))).not.toContainEqual({ from, to });
  });
});
