// Posting a comment into a real, drawn editor (#53). A selection across a fenced code
// block made CodeMirror throw while redrawing, after it had already applied the new
// state: the comment was never drawn or saved, the box stayed open, and every click
// added another hidden copy. These tests draw the editor in happy-dom with the same
// preview and composer-anchor extensions the app uses.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

import { setComposerAnchor, composerAnchorExtension } from "../editor/composerAnchor";
import { CriticMarkup } from "../editor/criticMarkupParser";
import { documentPreviewExtension } from "../editor/previewMode";
import { postToView } from "./useComposer";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const DOC = [
  "# Invite",
  "",
  "Hi both, I've invited you to the repository.",
  "",
  "Or, if you use Homebrew:",
  "",
  "```sh",
  "brew install example",
  "```",
  "",
  "Setup takes about five minutes.",
  "",
  "Tell me about anything broken.",
  "",
].join("\n");

const appExtensions: Extension[] = [
  markdown({ base: markdownLanguage, extensions: [CriticMarkup] }),
  documentPreviewExtension(true),
  composerAnchorExtension,
];

/** Draw `doc` in a real view, select [from, to) and open the composer's blue anchor
 *  over it, as openSelectionComposer does. */
function composing(doc: string, from: number, to: number, extra: Extension[] = []): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [...appExtensions, ...extra] }),
    parent,
  });
  view.dispatch({ selection: { anchor: from, head: to }, effects: setComposerAnchor.of({ from, to }) });
  return view;
}

function post(view: EditorView, text: string) {
  const sel = view.state.selection.main;
  return postToView(view, {
    author: "You",
    text,
    kind: "comment",
    range: { from: sel.from, to: sel.to },
    fallbackAt: sel.to,
  });
}

describe("postToView in a drawn editor", () => {
  test("a selection inside one paragraph anchors the comment to its span", () => {
    const from = DOC.indexOf("invited");
    const view = composing(DOC, from, from + "invited".length);

    const result = post(view, "Which repository?");

    expect(result.ok).toBe(true);
    expect(view.state.doc.toString()).toBe(
      DOC.replace("invited", "{==invited==}{>>@You: Which repository?<<}"),
    );
    view.destroy();
  });

  test("a selection across a code block posts one point comment at its end and draws it", () => {
    const from = DOC.indexOf("Homebrew");
    const to = DOC.indexOf("anything") + 4; // inside a word, after the code block
    const view = composing(DOC, from, to);

    const result = post(view, "Shorter?");

    expect(result.ok).toBe(true);
    expect(view.state.doc.toString()).toBe(
      DOC.replace("anything", "anyt {>>@You: Shorter?<<}hing"),
    );
    const drawn = view.contentDOM.querySelector(".cm-crit-comment-anchor--point");
    expect(drawn?.getAttribute("data-from")).toBe(String(DOC.indexOf("anything") + 5));
    view.destroy();
  });

  test("an update that throws while drawing leaves the editor as it was and returns the error", () => {
    // A widget that fails to draw once a comment is in the document stands in for any
    // redraw that throws after CodeMirror has applied the new state.
    class Broken extends WidgetType {
      toDOM(): HTMLElement {
        throw new Error("draw failed");
      }
    }
    const breaksOnComment = StateField.define({
      create: () => Decoration.none,
      update: (_value, tr) => {
        const at = tr.state.doc.toString().indexOf("{>>");
        return at < 0 ? Decoration.none : Decoration.set([Decoration.widget({ widget: new Broken() }).range(at)]);
      },
      provide: (field) => EditorView.decorations.from(field),
    });
    const from = DOC.indexOf("invited");
    const view = composing(DOC, from, from + "invited".length, [breaksOnComment]);
    const before = view.state;

    const result = post(view, "Which repository?");

    expect({ ok: result.ok, error: result.ok ? null : result.error?.message }).toEqual({
      ok: false,
      error: "draw failed",
    });
    expect(view.state).toBe(before);
    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });
});
