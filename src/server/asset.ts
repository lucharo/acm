// ── Image assets (issue #3) ───────────────────────────────────────────────────
// A dropped/pasted image is saved as a SIBLING FILE under <docDir>/assets/ and
// referenced from the markdown by relative path — never a data URI (see
// docs/adr/0002-images-as-sibling-assets.md). The filename is content-addressed:
// <slugged stem>-<hash8>.<ext>, so re-dropping the same image reuses the same
// file and names never collide without -1/-2 suffix bookkeeping.

import { join, resolve, sep, extname, basename } from "node:path";

// The insert gesture is images-only by decision (a PDF drop is rejected with a
// toast, not saved as a generic attachment). The server enforces it too — the
// route writes files to disk, so it must not trust the client's filter OR the
// filename: the bytes are magic-byte sniffed and must match the extension
// (roborev #3439). SVG is deliberately absent — it's a text format (nothing to
// sniff) and a script-bearing SVG served from /api/asset is a stored-XSS
// surface; hand-written .svg references on disk still render via GET.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);

// jpg/jpeg are one type; everything else maps to itself.
const canonical = (ext: string) => (ext === "jpg" ? "jpeg" : ext);

/** Sniff the actual image type from the leading magic bytes, or null. */
function sniffExt(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) =>
    bytes.length >= to ? String.fromCharCode(...bytes.subarray(from, to)) : "";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(0, 2) === "BM") return "bmp";
  if (ascii(4, 8) === "ftyp" && (ascii(8, 12) === "avif" || ascii(8, 12) === "avis")) return "avif";
  return null;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Content-addressed asset filename for an uploaded image, or null when the
 *  extension isn't an image type OR the bytes don't sniff as that type (a
 *  "photo.png" whose bytes aren't PNG is refused, not stored mislabelled).
 *  Same name + same bytes → same file. */
export function assetFileName(name: string, bytes: Uint8Array): string | null {
  const ext = extname(name).slice(1).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return null;
  if (sniffExt(bytes) !== canonical(ext)) return null;
  const stem = slug(basename(name, extname(name))) || "image";
  const hash = Bun.hash(bytes).toString(16).padStart(16, "0").slice(0, 8);
  return `${stem}-${hash}.${ext}`;
}

/** Write an uploaded image under <docDir>/assets/ and return its doc-relative
 *  path (what the markdown reference should hold), or null for non-images. */
export async function saveAsset(
  docDir: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ path: string } | null> {
  const file = assetFileName(name, bytes);
  if (!file) return null;
  const rel = `assets/${file}`;
  await Bun.write(join(docDir, rel), bytes); // creates assets/ on first write
  return { path: rel };
}

/** Resolve a doc-relative path to an absolute one, or null when it escapes the
 *  doc's directory (the traversal guard for GET /api/asset). Deliberately serves
 *  ANY path under docDir — not just assets/ — so hand-written references like
 *  ![](figures/plot.png) in pre-existing docs render too. */
export function resolveUnderDocDir(docDir: string, rel: string): string | null {
  const abs = resolve(docDir, rel);
  return abs === docDir || abs.startsWith(docDir + sep) ? abs : null;
}
