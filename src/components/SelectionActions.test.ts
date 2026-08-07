import { describe, expect, test } from "bun:test";

import { selectionToolbarPosition } from "./SelectionActions";

describe("selection action toolbar positioning", () => {
  test("centres above a same-line selection", () => {
    expect(
      selectionToolbarPosition(
        { left: 100, right: 101, top: 200, bottom: 220 },
        { left: 299, right: 300, top: 200, bottom: 220 },
        { top: 40, bottom: 760 },
        1000,
      ),
    ).toEqual({ left: 200, top: 190, placement: "above" });
  });

  test("moves below a selection near the top edge", () => {
    expect(
      selectionToolbarPosition(
        { left: 12, right: 13, top: 18, bottom: 38 },
        { left: 72, right: 73, top: 18, bottom: 38 },
        { top: 0, bottom: 760 },
        320,
      ),
    ).toEqual({ left: 132, top: 48, placement: "below" });
  });

  test("hides when the selected text is outside the editor viewport", () => {
    expect(
      selectionToolbarPosition(
        { left: 100, right: 101, top: -80, bottom: -60 },
        { left: 180, right: 181, top: -80, bottom: -60 },
        { top: 40, bottom: 760 },
        1000,
      ),
    ).toBeNull();
  });
});
