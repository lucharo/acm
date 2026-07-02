// Deterministic per-author color. Hashes the author name to one of the eight
// --author-N hues defined in src/index.css, so the same author always renders
// in the same color across the sidebar and nav panel. A null / empty author
// falls back to the neutral --muted var.

const AUTHOR_HUE_COUNT = 8;

/**
 * Map an author name to a stable CSS color string.
 *   authorColor("editor") -> "var(--author-3)"
 *   authorColor(null)      -> "var(--muted)"
 * The hash is a simple FNV-style fold so it stays deterministic across reloads
 * and is independent of insertion order.
 */
export function authorColor(author: string | null): string {
  if (!author) return "var(--muted)";

  let hash = 0;
  for (let i = 0; i < author.length; i++) {
    // (hash * 31 + charCode), kept in 32-bit space.
    hash = (Math.imul(hash, 31) + author.charCodeAt(i)) | 0;
  }
  const index = ((hash % AUTHOR_HUE_COUNT) + AUTHOR_HUE_COUNT) % AUTHOR_HUE_COUNT;
  return `var(--author-${index})`;
}

/**
 * Stable color for a SUGGESTION GROUP id, so every member of one group
 * (`SUGGEST[g:id]`) shares a hue the eye can cluster on. Uses a CONTINUOUS HSL hue
 * (not the 8-slot author palette) so nearby groups don't collide — the whole point
 * is telling one group from another. Mid saturation + lightness read on both light
 * and dark panels; the same value drives the card spine and the group tag.
 */
export function groupColor(groupId: string): string {
  let hash = 0;
  for (let i = 0; i < groupId.length; i++) {
    hash = (Math.imul(hash, 31) + groupId.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 62%, 52%)`;
}
