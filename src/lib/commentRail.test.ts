import { describe, expect, test } from "bun:test";

import {
  commentEdgeVisible,
  commentRailExpanded,
  commentStatusOccluded,
  anchorNeedsCentring,
  innerScrollerTakesWheel,
  stepReviewCard,
} from "./commentRail";
import type { SidebarCard } from "./types";
import type { WheelBox } from "./commentRail";

describe("comment edge visibility", () => {
  test("automatic mode hides an empty rail and opens for visible review cards", () => {
    expect(commentRailExpanded("auto", false, false)).toBe(false);
    expect(commentRailExpanded("auto", true, false)).toBe(true);
  });

  test("show and hide override the visible comment count", () => {
    expect(commentRailExpanded("show", false, false)).toBe(true);
    expect(commentRailExpanded("hide", true, false)).toBe(false);
  });

  test("an explicit authoring action temporarily opens the rail", () => {
    expect(commentRailExpanded("hide", true, true)).toBe(true);
  });

  test("the comments-edge toggle reflects the narrow mobile review surface", () => {
    expect(commentEdgeVisible("auto", false, false, true)).toBe(true);
    expect(commentEdgeVisible("hide", false, false, true)).toBe(false);
  });

  test("the rail-status pill hides only while a review card occupies its corner", () => {
    expect(commentStatusOccluded([{ top: 8, bottom: 96 }])).toBe(true);
    expect(commentStatusOccluded([{ top: 52, bottom: 140 }])).toBe(false);
    expect(commentStatusOccluded([{ top: -90, bottom: -2 }])).toBe(false);
  });

  test("any visible card can occlude the status corner after scrolling", () => {
    expect(
      commentStatusOccluded([
        { top: -120, bottom: -20 },
        { top: 20, bottom: 110 },
      ]),
    ).toBe(true);
  });
});

describe("innerScrollerTakesWheel (#67)", () => {
  // A popover list inside a card inside the rail: only the list scrolls.
  function tree(list: Partial<WheelBox>) {
    const rail: WheelBox = { scrollTop: 0, scrollHeight: 800, clientHeight: 800, scrollable: false, parent: null };
    const card: WheelBox = { scrollTop: 0, scrollHeight: 300, clientHeight: 300, scrollable: false, parent: rail };
    const scroller: WheelBox = { scrollTop: 0, scrollHeight: 900, clientHeight: 240, scrollable: true, parent: card, ...list };
    const row: WheelBox = { scrollTop: 0, scrollHeight: 20, clientHeight: 20, scrollable: false, parent: scroller };
    return { row };
  }

  test("a scrollable list with room in the wheel's direction keeps the wheel", () => {
    const { row } = tree({ scrollTop: 100 });
    expect([innerScrollerTakesWheel(row, 40), innerScrollerTakesWheel(row, -40)]).toEqual([true, true]);
  });

  test("a list at its end hands the wheel back to the document", () => {
    const top = tree({ scrollTop: 0 });
    const bottom = tree({ scrollTop: 660 });
    expect([
      innerScrollerTakesWheel(top.row, -40),
      innerScrollerTakesWheel(bottom.row, 40),
    ]).toEqual([false, false]);
  });

  test("a card with nothing to scroll forwards the wheel", () => {
    const { row } = tree({ scrollable: false });
    expect(innerScrollerTakesWheel(row, 40)).toBe(false);
  });
});

describe("stepReviewCard (#43)", () => {
  const card = (id: string, from: number, commentIds: string[] = [id]): SidebarCard => ({
    kind: "comment",
    id,
    from,
    to: from + 10,
    comments: commentIds.map((cid) => ({ id: cid, type: "comment", from, to: from + 10, raw: "", author: null, body: "" })),
  });
  // Deliberately out of document order: stepping follows offsets, not array order.
  const cards = [card("c", 300), card("a", 100, ["a", "a-reply"]), card("b", 200)];

  test("steps forward and back in document order and wraps at both ends", () => {
    expect([
      stepReviewCard(cards, "a", 1)?.id,
      stepReviewCard(cards, "b", -1)?.id,
      stepReviewCard(cards, "c", 1)?.id,
      stepReviewCard(cards, "a", -1)?.id,
    ]).toEqual(["b", "a", "a", "c"]);
  });

  test("finds the active card through any of its comments", () => {
    expect(stepReviewCard(cards, "a-reply", 1)?.id).toBe("b");
  });

  test("with no active card, opens the first or the last", () => {
    expect([stepReviewCard(cards, null, 1)?.id, stepReviewCard(cards, null, -1)?.id]).toEqual(["a", "c"]);
  });

  test("returns null when there is nothing to step to", () => {
    expect([stepReviewCard([], null, 1), stepReviewCard([card("a", 1)], "a", 1)]).toEqual([null, null]);
  });
});

describe("anchorNeedsCentring (#43)", () => {
  // Viewport from y=100 to y=900: the comfortable band is 124..700.
  test("leaves an anchor that already sits in the upper three quarters alone", () => {
    expect(anchorNeedsCentring(300, 320, 100, 900)).toBe(false);
  });

  test("centres an anchor near the bottom edge, where its card would be cut off", () => {
    expect(anchorNeedsCentring(820, 840, 100, 900)).toBe(true);
  });

  test("centres an anchor above the top or off-screen", () => {
    expect([anchorNeedsCentring(90, 110, 100, 900), anchorNeedsCentring(2000, 2020, 100, 900)]).toEqual([true, true]);
  });
});
