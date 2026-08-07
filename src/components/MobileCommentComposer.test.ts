import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MobileCommentComposer from "./MobileCommentComposer";

describe("mobile comment composer", () => {
  test("uses zoom-safe text and touch-sized controls without desktop shortcuts", () => {
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
    expect(html).not.toContain("⌘");
  });
});
