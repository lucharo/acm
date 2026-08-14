import { describe, expect, test } from "bun:test";

import { provenanceSummary, selectionToolbarPosition } from "./SelectionActions";

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

describe("selection authorship summary", () => {
  test("names an accepted suggestion's proposer and reviewer", () => {
    const summary = provenanceSummary([{
      from: 4,
      to: 12,
      author: "Claude",
      source: "suggestion",
      timestamp: "2026-08-12T10:02:00.000Z",
      reviewedBy: "Luis",
      decisionId: "decision-1",
    }]);
    expect(summary?.label).toBe("By Claude · reviewed by Luis");
    expect(summary?.title).toContain("Claude · accepted suggestion · reviewed by Luis");
    expect(summary?.title).toContain("12 Aug 2026");
  });

  test("summarises a mixed-author selection without repeating an author", () => {
    expect(provenanceSummary([
      { from: 0, to: 3, author: "Luis", source: "human", timestamp: "2026-08-12T10:00:00.000Z" },
      { from: 3, to: 5, author: "Luis", source: "human", timestamp: "2026-08-12T10:01:00.000Z" },
      { from: 5, to: 9, author: "Codex", source: "agent", timestamp: "2026-08-12T10:02:00.000Z" },
    ])).toEqual({
      label: "Mixed: Luis, Codex",
      title: "Selection contains text by Luis and Codex",
    });
  });
});
