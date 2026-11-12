import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MOD } from "../lib/platform";
import MobileCommentComposer from "./MobileCommentComposer";

describe("mobile comment composer", () => {
  test("uses zoom-safe text and touch-sized controls", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(MobileCommentComposer, {
        draft: "Mobile note",
        anchored: true,
        onDraftChange: noop,
        onPost: noop,
        onPostDone: noop,
        onCancel: noop,
      }),
    );

    expect(html).toContain("text-base");
    expect(html).toContain("min-h-11");
    expect(html).toContain("disabled:bg-transparent");
  });

  test("shows the buttons' shortcuts on a fine pointer and hides them on touch (#54)", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(MobileCommentComposer, {
        draft: "Mobile note",
        anchored: true,
        onDraftChange: noop,
        onPost: noop,
        onPostDone: noop,
        onCancel: noop,
      }),
    );
    const hints = [...html.matchAll(/<span class="([^"]*)">([^<]*)<\/span>/g)]
      .filter(([, , text]) => text.startsWith(MOD))
      .map(([, cls, text]) => ({ text, touch: cls.split(" ").includes("hidden"), fine: cls.split(" ").includes("pointer-fine:inline") }));

    expect(hints).toEqual([
      { text: `${MOD}⇧↵`, touch: true, fine: true },
      { text: `${MOD}↵`, touch: true, fine: true },
    ]);
  });

  test("labels replacement proposals as suggestions and omits the done action", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(MobileCommentComposer, {
        kind: "suggestion",
        draft: "Clearer wording",
        anchored: true,
        onDraftChange: noop,
        onPost: noop,
        onPostDone: noop,
        onCancel: noop,
      }),
    );

    expect(html).toContain('aria-label="Suggested replacement"');
    expect(html).toContain("Create suggestion");
    expect(html).not.toContain("Post &amp; done");
  });
});
