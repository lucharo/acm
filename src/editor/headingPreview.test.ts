import { describe, expect, test } from "bun:test";
import {
  headingPreviewClass,
  previewStyleNeedsRebuild,
  shouldHideHeadingMark,
} from "./markdownPreview";

describe("predictable heading preview", () => {
  test("an active Setext heading stays raw while either source line is being edited", () => {
    expect(headingPreviewClass("SetextHeading2", true)).toBeNull();
    expect(shouldHideHeadingMark("SetextHeading2", true, false)).toBe(false);
  });

  test("a settled explicit Setext heading still renders as a heading", () => {
    expect(headingPreviewClass("SetextHeading1", false)).toBe("cm-md-h1");
    expect(shouldHideHeadingMark("SetextHeading1", false, false)).toBe(true);
  });

  test("ATX headings keep their existing rich preview", () => {
    expect(headingPreviewClass("ATXHeading2", true)).toBe("cm-md-h2");
  });

  test("ordinary paragraph nodes never receive heading styling", () => {
    expect(headingPreviewClass("Paragraph", true)).toBeNull();
  });

  test("focus-only changes rebuild Setext heading styling", () => {
    expect(
      previewStyleNeedsRebuild({
        docChanged: false,
        viewportChanged: false,
        selectionSet: false,
        focusChanged: true,
        treeChanged: false,
      }),
    ).toBe(true);
  });
});
