import type { CommentRailMode } from "./viewSettings";
import type { SidebarCard } from "./types";

/** The status pill is a viewport control, while review cards track document
 * scroll. Hide the pill whenever a card occupies its corner; the card is then
 * already visible, so the pill's jump action is redundant until scrolling
 * clears that space. */
export function commentStatusOccluded(
  cardBounds: Array<{ top: number; bottom: number }>,
): boolean {
  const statusTop = 4;
  const statusBottom = 44;
  return cardBounds.some(({ top, bottom }) => top < statusBottom && bottom > statusTop);
}

/** Resolve the persisted preference against current review state. Authoring is
 * always explicit, so opening a composer temporarily reveals its rail even when
 * the passive comment edge is hidden. */
export function commentRailExpanded(
  mode: CommentRailMode,
  hasVisibleCards: boolean,
  composing: boolean,
): boolean {
  if (composing) return true;
  if (mode === "show") return true;
  if (mode === "hide") return false;
  return hasVisibleCards;
}

/** State represented by the global comments-edge toggle. On narrow layouts the
 * desktop rail is absent, but the mobile review surface is still the same edge. */
export function commentEdgeVisible(
  mode: CommentRailMode,
  railWideEnough: boolean,
  railExpanded: boolean,
  hasVisibleCards: boolean,
): boolean {
  if (railWideEnough) return railExpanded;
  return mode !== "hide" && hasVisibleCards;
}

/** The part of an element the rail's wheel forwarding needs: its vertical scroll
 *  state, whether its CSS lets it scroll (overflow-y auto/scroll), and its parent. */
export interface WheelBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollable: boolean;
  parent: WheelBox | null;
}

/** The rail forwards wheel and trackpad scrolling to the document, because cards
 *  have no scroll of their own. A scrollable region INSIDE a card (a group's member
 *  list, a long reply draft) must keep the wheel while it still has room to move in
 *  that direction, or it can never scroll (#67). Walks from the event target up its
 *  parents; the caller's adapter ends the chain at the rail. */
export function innerScrollerTakesWheel(target: WheelBox | null, deltaY: number): boolean {
  for (let box = target; box; box = box.parent) {
    if (!box.scrollable || box.scrollHeight <= box.clientHeight + 1) continue;
    if (deltaY < 0 && box.scrollTop > 0) return true;
    if (deltaY > 0 && box.scrollTop + box.clientHeight < box.scrollHeight - 1) return true;
  }
  return false;
}

/** The card one step from the active one, in document order, wrapping at both
 *  ends: the rail's ↑/↓ keys and the status pill's arrows (#43). With no active
 *  card, ↓ opens the first and ↑ the last. Null when there is nowhere to go. */
export function stepReviewCard(
  cards: readonly SidebarCard[],
  activeId: string | null,
  direction: 1 | -1,
): SidebarCard | null {
  const ordered = [...cards].sort((a, b) => a.from - b.from);
  if (ordered.length === 0) return null;
  const index = ordered.findIndex(
    (card) => card.id === activeId || card.comments.some((comment) => comment.id === activeId),
  );
  if (index < 0) return direction > 0 ? ordered[0] : ordered[ordered.length - 1];
  if (ordered.length === 1) return null;
  return ordered[(index + direction + ordered.length) % ordered.length];
}

/** Whether travelling to a card must scroll its anchor to the middle of the view
 *  (#43). An anchor already in the upper three quarters stays put, so clicking a
 *  visible card does not move the page; one near the bottom edge, above the top
 *  or off-screen is centred, because the active card floats at its anchor line
 *  and needs room below it. Screen coordinates. */
export function anchorNeedsCentring(
  anchorTop: number,
  anchorBottom: number,
  viewTop: number,
  viewBottom: number,
): boolean {
  const comfortableBottom = viewTop + (viewBottom - viewTop) * 0.75;
  return anchorTop < viewTop + 24 || anchorBottom > comfortableBottom;
}
