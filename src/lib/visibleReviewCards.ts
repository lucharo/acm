import type { SidebarCard } from "./types";

/** Keep a mobile review target in the uncovered strip above the bottom sheet.
 * `nearest` is insufficient because it runs before the fixed sheet appears and
 * can leave an anchor that was technically visible underneath the new sheet. */
export function mobileReviewScrollOptions() {
  return { y: "start", yMargin: 72 } as const;
}

/** The cards that genuinely occupy the review rail for the current seen filter.
 * Suggestions never enter the seen set, so they remain visible until decided. */
export function visibleReviewCards(
  cards: readonly SidebarCard[],
  seenIds: ReadonlySet<string>,
  showSeen: boolean,
  exiting: ReadonlySet<string> = new Set(),
): SidebarCard[] {
  if (showSeen) return [...cards];
  return cards.filter((card) => !seenIds.has(card.id) || exiting.has(card.id));
}

/** Next card for the compact/mobile review flow. With no active card, open the
 * first visible one; otherwise advance in document order and wrap. A one-card
 * list has no "Next" target. */
export function nextVisibleReviewCard(
  cards: readonly SidebarCard[],
  active: SidebarCard | null,
): SidebarCard | null {
  if (cards.length === 0) return null;
  if (!active) return cards[0];
  return (
    cards.find((card) => card.from > active.from && card.id !== active.id) ??
    cards.find((card) => card.id !== active.id) ??
    null
  );
}

/** The active compact/mobile card under the current filter. */
export function activeVisibleReviewCard(
  cards: readonly SidebarCard[],
  seenIds: ReadonlySet<string>,
  showSeen: boolean,
  activeId: string | null,
): SidebarCard | null {
  const visible = visibleReviewCards(cards, seenIds, showSeen);
  return (
    visible.find(
      (card) => card.id === activeId || card.comments.some((comment) => comment.id === activeId),
    ) ?? null
  );
}
