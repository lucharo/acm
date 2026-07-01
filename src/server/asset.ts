// ── Image assets (issue #3) ───────────────────────────────────────────────────
// A dropped/pasted image is saved as a SIBLING FILE under <docDir>/assets/ and
// referenced from the markdown by relative path — never a data URI (see
// docs/adr/0002-images-as-sibling-assets.md). The filename is content-addressed:
// <slugged stem>-<hash8>.<ext>, so re-dropping the same image reuses the same
// file and names never collide without -1/-2 suffix bookkeeping.

import { join, resolve, sep, extname, basename } from "node:path";
import { IMAGE_EXTS } from "../lib/imageTypes";

// The insert gesture is images-only by decision (a PDF drop is rejected with a
// toast, not saved as a generic attachment). The server enforces it too — the
// route writes files to disk, so it must not trust the client's filter OR the
// filename: the bytes are magic-byte sniffed and must match the extension
// (roborev #3439). The whitelist itself is the shared lib/imageTypes table.

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

/** The naming scheme's parts, or null when the extension isn't an image type
 *  OR the bytes don't sniff as that type (a "photo.png" whose bytes aren't PNG
 *  is refused, not stored mislabelled). */
function assetParts(name: string, bytes: Uint8Array): { stem: string; file: string } | null {
  const ext = extname(name).slice(1).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return null;
  if (sniffExt(bytes) !== canonical(ext)) return null;
  const stem = slug(basename(name, extname(name))) || "image";
  const hash = Bun.hash(bytes).toString(16).padStart(16, "0").slice(0, 8);
  return { stem, file: `${stem}-${hash}.${ext}` };
}

/** Content-addressed asset filename. Same name + same bytes → same file. */
export function assetFileName(name: string, bytes: Uint8Array): string | null {
  return assetParts(name, bytes)?.file ?? null;
}

/** Write an uploaded image under <docDir>/assets/ and return its doc-relative
 *  path (what the markdown reference should hold) plus the slugged stem (the
 *  client's alt text — returned so the client never re-parses the naming
 *  scheme), or null for non-images. */
export async function saveAsset(
  docDir: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ path: string; stem: string } | null> {
  const parts = assetParts(name, bytes);
  if (!parts) return null;
  const rel = `assets/${parts.file}`;
  const dest = join(docDir, rel);
  // Content-addressed: if the file exists its bytes are these bytes — skip the
  // rewrite (the dedup the name promises, without the redundant I/O).
  if (!(await Bun.file(dest).exists())) await Bun.write(dest, bytes); // creates assets/ on first write
  return { path: rel, stem: parts.stem };
}

// What GET /api/asset may serve: the upload types plus svg (a hand-written
// on-disk .svg reference renders; svg just isn't an accepted UPLOAD). The
// extension whitelist keeps the route an IMAGE route — without it, any file
// under the doc's directory (settings.json, sibling .md drafts) would be
// readable by whoever can reach the server.
const SERVABLE_EXTS = new Set([...IMAGE_EXTS, "svg"]);

/** Resolve a doc-relative IMAGE path to an absolute one, or null when it
 *  escapes the doc's directory (traversal guard) or isn't an image type.
 *  Deliberately allows any directory under docDir — not just assets/ — so
 *  hand-written references like ![](figures/plot.png) render too. */
export function resolveUnderDocDir(docDir: string, rel: string): string | null {
  if (!SERVABLE_EXTS.has(extname(rel).slice(1).toLowerCase())) return null;
  const abs = resolve(docDir, rel);
  return abs.startsWith(docDir + sep) ? abs : null;
}
