// Reading and writing the document's text (#92). A file that starts with a UTF-8
// BOM is handled as its text without the BOM everywhere in memory (the editor, the
// merge base, every comparison), and the BOM is written back on disk, so a BOM
// document behaves like any other and keeps its bytes. Every reader and writer of
// the served document goes through these two functions.

const BOM_BYTES = [0xef, 0xbb, 0xbf];
const BOM = "\uFEFF";

async function startsWithBom(path: string): Promise<boolean> {
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  const head = new Uint8Array(await file.slice(0, 3).arrayBuffer());
  return BOM_BYTES.every((byte, i) => head[i] === byte);
}

/** Does `text` start with a BOM? The write routes refuse such content (memory
 *  never holds one), rather than strip it and shift the offsets that come with it. */
/** Refuses invalid bytes, where a lossy decode would store U+FFFD as if it were text.
 *  Keeps a BOM, so JSON.parse rejects one just as req.json() does. */
export const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function startsWithBomChar(text: string): boolean {
  return text.startsWith(BOM);
}

function stripBom(text: string): string {
  return startsWithBomChar(text) ? text.slice(1) : text;
}

/** The document's text without a leading BOM. A missing file throws (ENOENT),
 *  as `Bun.file().text()` does, so a mistyped path is never read as empty. */
export async function readDocText(path: string): Promise<string> {
  return stripBom(await Bun.file(path).text());
}

/** Write `text` to the document, keeping a BOM the file already had. `text`
 *  must not itself start with U+FEFF (an edit that exposes one at the start):
 *  stripping it would shift every offset reported for the write, so refuse. */
export async function writeDocText(path: string, text: string): Promise<void> {
  if (startsWithBomChar(text)) {
    throw new Error("refusing to write a document whose text starts with U+FEFF (a byte-order mark)");
  }
  await Bun.write(path, (await startsWithBom(path)) ? BOM + text : text);
}
