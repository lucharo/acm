import { describe, expect, test } from "bun:test";
import {
  activeVisibleReviewCard,
  mobileReviewScrollOptions,
  nextVisibleReviewCard,
  visibleReviewCards,
} from "./visibleReviewCards";
import type { SidebarCard } from "./types";

const comment = (id: string): SidebarCard => ({
  kind: "comment",
  id,
  from: 0,
  to: 1,
  comments: [],
});

const suggestion = (id: string): SidebarCard => ({
  kind: "suggestion",
  id,
  from: 0,
  to: 1,
  standalone: false,
  suggestion: {
    id,
    type: "insert",
    from: 0,
    to: 1,
    raw: "{++x++}",
    inner: "x",
  },
  comments: [],
});

describe("visibleReviewCards", () => {
  test("returns no rail content for an empty document", () => {
    expect(visibleReviewCards([], new Set(), false)).toEqual([]);
  });

  test("hides seen comments while keeping unseen comments and suggestions", () => {
    const cards = [comment("seen"), comment("open"), suggestion("suggest")];

    expect(visibleReviewCards(cards, new Set(["seen"]), false).map((card) => card.id)).toEqual([
      "open",
      "suggest",
    ]);
  });

  test("show-seen restores every card", () => {
    const cards = [comment("seen"), suggestion("suggest")];

    expect(visibleReviewCards(cards, new Set(["seen"]), true)).toEqual(cards);
  });

  test("keeps a newly hidden card mounted during its exit transition", () => {
    const cards = [comment("seen")];

    expect(visibleReviewCards(cards, new Set(["seen"]), false, new Set(["seen"]))).toEqual(cards);
  });
});

describe("nextVisibleReviewCard", () => {
  const cards = [comment("first"), comment("second")];

  test("opens the first visible card when none is active", () => {
    expect(nextVisibleReviewCard(cards, null)?.id).toBe("first");
  });

  test("advances then wraps without offering the active card as its own next item", () => {
    expect(nextVisibleReviewCard(cards, cards[0])?.id).toBe("second");
    expect(nextVisibleReviewCard(cards, cards[1])?.id).toBe("first");
    expect(nextVisibleReviewCard([cards[0]], cards[0])).toBeNull();
  });
});

test("mobile review navigation keeps the anchor above the bottom sheet", () => {
  expect(mobileReviewScrollOptions()).toEqual({ y: "start", yMargin: 72 });
});

describe("activeVisibleReviewCard", () => {
  test("hiding seen comments also closes a now-filtered active mobile card", () => {
    const cards = [comment("seen"), comment("open")];

    expect(activeVisibleReviewCard(cards, new Set(["seen"]), false, "seen")).toBeNull();
    expect(activeVisibleReviewCard(cards, new Set(["seen"]), false, "open")?.id).toBe(
      "open",
    );
  });
});
