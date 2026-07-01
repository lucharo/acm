// ── Accepted image formats (issue #3) ─────────────────────────────────────────
// The ONE table for the image-insert whitelist, shared by the client filter
// (editor/imageInsert.ts) and the server authority (server/asset.ts) so the two
// sides — and the 415 message — can never drift. SVG is deliberately absent:
// text format, nothing to magic-byte sniff, stored-XSS surface (ADR-0002).

export const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

/** Extensions accepted in upload names (jpg and jpeg are one type). */
export const IMAGE_EXTS: ReadonlySet<string> = new Set([
  ...Object.values(IMAGE_EXT_BY_MIME),
  "jpeg",
]);

/** Human list for error messages, derived from the same table. */
export const IMAGE_EXTS_LABEL = Object.values(IMAGE_EXT_BY_MIME).join(", ");
