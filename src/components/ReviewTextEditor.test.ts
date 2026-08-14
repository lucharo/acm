import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ReviewTextEditor, {
  closeReviewEditorAfterSuccessfulSave,
  reviewEditKeyAction,
} from "./ReviewTextEditor";

describe("review text editor", () => {
  test("renders one focused edit surface with explicit save and cancel actions", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewTextEditor, {
        value: "revised wording",
        label: "Edit suggestion",
        onChange: () => {},
        onSave: () => {},
        onCancel: () => {},
      }),
    );

    expect(html).toContain('aria-label="Edit suggestion"');
    expect(html).toContain("revised wording");
    expect(html).toContain(">Save");
    expect(html).toContain(">Cancel");
  });

  test("uses Mod-Enter to save, Escape to cancel, and leaves ordinary Enter alone", () => {
    expect(reviewEditKeyAction({ key: "Enter", metaKey: true, ctrlKey: false })).toBe("save");
    expect(reviewEditKeyAction({ key: "Enter", metaKey: false, ctrlKey: true })).toBe("save");
    expect(reviewEditKeyAction({ key: "Escape", metaKey: false, ctrlKey: false })).toBe("cancel");
    expect(reviewEditKeyAction({ key: "Enter", metaKey: false, ctrlKey: false })).toBeNull();
  });

  test("keeps a rejected edit open and closes only after a successful save", () => {
    let closes = 0;
    expect(closeReviewEditorAfterSuccessfulSave(() => false, () => { closes += 1; })).toBe(false);
    expect(closes).toBe(0);

    expect(closeReviewEditorAfterSuccessfulSave(() => true, () => { closes += 1; })).toBe(true);
    expect(closes).toBe(1);
  });
});
