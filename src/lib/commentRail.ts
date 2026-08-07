import type { CommentRailMode } from "./viewSettings";

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
