import {
  DOMParser,
  type Document as XmlDocument,
  type Element as XmlElement,
  type Node as XmlNode,
} from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { resolve } from "node:path";
import { formatComment as formatCriticComment, wrappableSpan } from "../lib/criticmarkup";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

type ImportToken =
  | { kind: "text"; value: string }
  | { kind: "paragraph"; prefix: string };

interface ImportedComment {
  author: string;
  body: string;
}

export interface DocxImportResult {
  markdown: string;
  comments: number;
  highlights: number;
}

/** Convert a Google Docs editor/share URL to the public DOCX export endpoint. */
export function googleDocsExportUrl(source: string): URL {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("not a valid Google Docs URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com") {
    throw new Error("Google Docs URLs must use https://docs.google.com");
  }
  const match = url.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([^/]+)/);
  if (!match) throw new Error("not a Google Docs document URL");
  return new URL(`/document/d/${match[1]}/export?format=docx`, url.origin);
}

export interface DownloadedGoogleDoc {
  bytes: Uint8Array;
  filename: string;
}

type FetchDocument = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function downloadedFilename(header: string | null): string | null {
  if (!header) return null;
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = header.match(/filename="([^"]+)"/i)?.[1] ?? header.match(/filename=([^;]+)/i)?.[1];
  let raw = plain?.trim();
  if (encoded) {
    try {
      raw = decodeURIComponent(encoded);
    } catch {
      // Ignore a malformed RFC 5987 value and fall back to the plain filename.
    }
  }
  if (!raw) return null;
  const safe = raw.split(/[\\/]/).at(-1)?.trim();
  return safe && /\.docx$/i.test(safe) ? safe : null;
}

/** Download a link-accessible Google Doc through Google's DOCX export endpoint. */
export async function downloadGoogleDocsDocx(
  source: string,
  fetchDocument: FetchDocument = fetch,
): Promise<DownloadedGoogleDoc> {
  const exportUrl = googleDocsExportUrl(source);
  const id = exportUrl.pathname.split("/")[3];
  const response = await fetchDocument(exportUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "Google Doc is not publicly downloadable; download it as .docx and pass that file path instead",
    );
  }
  if (!response.ok) throw new Error(`Google Docs export failed (${response.status} ${response.statusText})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(
      "Google Docs did not return a DOCX file; check link access or download it as .docx",
    );
  }
  return {
    bytes,
    filename: downloadedFilename(response.headers.get("Content-Disposition")) ?? `google-doc-${id}.docx`,
  };
}

export interface ImportDocumentResult extends DocxImportResult {
  outputPath: string;
}

/** Import either a local DOCX or a link-accessible Google Docs URL. */
export async function importDocument(
  source: string,
  output?: string,
  fetchDocument: FetchDocument = fetch,
): Promise<ImportDocumentResult> {
  let bytes: Uint8Array;
  let defaultName: string;
  if (/^https?:\/\//i.test(source)) {
    const downloaded = await downloadGoogleDocsDocx(source, fetchDocument);
    bytes = downloaded.bytes;
    defaultName = downloaded.filename.replace(/\.docx$/i, ".md");
  } else {
    if (!/\.docx$/i.test(source)) throw new Error("source must be a Google Docs URL or a .docx file");
    const sourcePath = resolve(source);
    if (!(await Bun.file(sourcePath).exists())) throw new Error(`file not found: ${source}`);
    bytes = await Bun.file(sourcePath).bytes();
    defaultName = sourcePath.replace(/\.docx$/i, ".md");
  }
  const outputPath = resolve(output ?? defaultName);
  if (!/\.md$/i.test(outputPath)) throw new Error("output must be a .md file");
  const imported = convertDocx(bytes);
  await Bun.write(outputPath, imported.markdown);
  return { ...imported, outputPath };
}

function wordAttribute(element: XmlElement, name: string): string {
  return element.getAttributeNS(WORD_NS, name) ?? element.getAttribute(`w:${name}`) ?? "";
}

function wordElements(root: XmlDocument | XmlElement, name: string): XmlElement[] {
  return Array.from(root.getElementsByTagNameNS(WORD_NS, name));
}

function textWithin(element: XmlElement): string {
  let text = "";
  const walk = (node: XmlNode): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      const wordElement = child as XmlElement;
      switch (wordElement.localName) {
        case "t":
          text += wordElement.textContent ?? "";
          break;
        case "delText":
          break; // resolved comment text excludes tracked deletions
        case "del":
          break; // skip the whole revision, including deleted tabs and breaks
        case "tab":
          text += "\t";
          break;
        case "br":
        case "cr":
          text += "\n";
          break;
        default:
          walk(wordElement);
      }
    }
  };
  walk(element);
  return text;
}

function parseXml(xml: string, filename: string): XmlDocument {
  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level === "error" || level === "fatalError") errors.push(message);
    },
  }).parseFromString(xml, "application/xml");
  if (errors.length > 0) throw new Error(`${filename}: invalid XML (${errors[0]})`);
  return doc;
}

function parseComments(xml?: string): Map<string, ImportedComment> {
  const comments = new Map<string, ImportedComment>();
  if (!xml) return comments;
  const doc = parseXml(xml, "word/comments.xml");
  for (const comment of wordElements(doc, "comment")) {
    const body = wordElements(comment, "p")
      .map(textWithin)
      .join("\n\n");
    const id = wordAttribute(comment, "id");
    if (comments.has(id)) throw new Error(`word/comments.xml: duplicate comment id ${id}`);
    comments.set(id, {
      author: wordAttribute(comment, "author"),
      body,
    });
  }
  return comments;
}

function formatComment(comments: Map<string, ImportedComment>, id: string): string {
  const comment = comments.get(id);
  if (!comment) throw new Error(`comment ${id} has no entry in word/comments.xml`);
  return formatCriticComment(comment.author, comment.body);
}

function directWordChild(element: XmlElement, name: string): XmlElement | undefined {
  return Array.from(element.childNodes).find(
    (child): child is XmlElement => child.nodeType === 1 && child.localName === name,
  );
}

function paragraphPrefix(paragraph: XmlElement): string {
  const properties = directWordChild(paragraph, "pPr");
  if (!properties) return "";
  const style = directWordChild(properties, "pStyle");
  const styleName = style && wordAttribute(style, "val");
  const heading = styleName?.match(/^Heading(\d+)$/i);
  if (heading) return `${"#".repeat(Math.min(Number(heading[1]), 6))} `;
  const numbering = directWordChild(properties, "numPr");
  if (!numbering) return "";
  const level = directWordChild(numbering, "ilvl");
  const depth = Math.max(0, Number(level && wordAttribute(level, "val")) || 0);
  return `${"  ".repeat(depth)}- `;
}

type TrackedMarker = readonly [open: string, close: string];
const INSERTION: TrackedMarker = ["{++", "++}"];
const DELETION: TrackedMarker = ["{--", "--}"];

function balancedTrackedChanges(span: string): boolean {
  for (const [open, close] of [INSERTION, DELETION]) {
    let depth = 0;
    for (let i = 0; i < span.length - 2; ) {
      if (span.startsWith(open, i)) {
        depth++;
        i += 3;
      } else if (span.startsWith(close, i)) {
        depth--;
        if (depth < 0) return false;
        i += 3;
      } else {
        i++;
      }
    }
    if (depth !== 0) return false;
  }
  return true;
}

export function convertDocx(bytes: Uint8Array): DocxImportResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (entry) => entry.name === "word/document.xml" || entry.name === "word/comments.xml",
    });
  } catch (error) {
    throw new Error(`not a readable DOCX archive: ${(error as Error).message}`);
  }
  const documentBytes = files["word/document.xml"];
  if (!documentBytes) throw new Error("not a Word document (no word/document.xml)");

  const comments = parseComments(files["word/comments.xml"] && strFromU8(files["word/comments.xml"]));
  const doc = parseXml(strFromU8(documentBytes), "word/document.xml");
  const body = wordElements(doc, "body")[0];
  if (!body) throw new Error("not a Word document (no w:body)");

  const tokens: ImportToken[] = [];
  const openComments = new Map<string, number>();
  const unsafeComments = new Set<string>();
  let commentCount = 0;
  let highlightCount = 0;
  const placedComments = new Set<string>();
  const tracked: TrackedMarker[] = [];
  let openingMarker: ImportToken | null = null;
  const deferredNotes: string[] = [];

  const flushDeferredNotes = (): void => {
    if (tracked.length !== 0) return;
    for (const note of deferredNotes.splice(0)) tokens.push({ kind: "text", value: note });
  };

  const openTracked = (): void => {
    const marker = tracked.at(-1);
    if (!marker) return;
    openingMarker = { kind: "text", value: marker[0] };
    tokens.push(openingMarker);
  };

  // A suggestion can hold neither a paragraph break nor another suggestion, and
  // a revision marker with nothing inside it (a tracked paragraph mark or table
  // row) is not a suggestion at all.
  const closeTracked = (): void => {
    const marker = tracked.at(-1);
    if (!marker) return;
    if (tokens.at(-1) === openingMarker) tokens.pop();
    else tokens.push({ kind: "text", value: marker[1] });
  };

  const walkTracked = (element: XmlElement, marker: TrackedMarker): void => {
    closeTracked();
    tracked.push(marker);
    openTracked();
    walk(element);
    closeTracked();
    tracked.pop();
    openTracked();
    flushDeferredNotes();
  };

  const walk = (node: XmlNode): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      const element = child as XmlElement;
      switch (element.localName) {
        case "p":
          walk(element);
          closeTracked();
          tokens.push({ kind: "paragraph", prefix: paragraphPrefix(element) });
          openTracked();
          break;
        case "ins":
        case "moveTo":
          walkTracked(element, INSERTION);
          break;
        case "del":
        case "moveFrom":
          walkTracked(element, DELETION);
          break;
        case "Fallback":
          break; // mc:Choice already carried this content; a renderer shows one or the other
        case "commentRangeStart":
          if (!openComments.has(wordAttribute(element, "id"))) {
            const id = wordAttribute(element, "id");
            if (openComments.size > 0) {
              unsafeComments.add(id);
              for (const openId of openComments.keys()) unsafeComments.add(openId);
            }
            openComments.set(id, tokens.length);
          }
          break;
        case "commentRangeEnd": {
          const id = wordAttribute(element, "id");
          if (placedComments.has(id)) break;
          placedComments.add(id);
          const start = openComments.get(id);
          const note = formatComment(comments, id);
          if (start === undefined) {
            tokens.push({ kind: "text", value: note });
          } else if (unsafeComments.has(id)) {
            openComments.delete(id);
            unsafeComments.delete(id);
            if (tracked.length > 0) deferredNotes.push(note);
            else tokens.push({ kind: "text", value: note });
          } else if (tracked.length > 0) {
            openComments.delete(id);
            deferredNotes.push(note);
          } else {
            openComments.delete(id);
            const captured = tokens.slice(start);
            const lastParagraph = captured.reduce(
              (found, token, index) => (token.kind === "paragraph" ? index : found),
              -1,
            );
            const kept = lastParagraph >= 0 ? captured.slice(0, lastParagraph + 1) : [];
            const anchor = lastParagraph >= 0 ? captured.slice(lastParagraph + 1) : captured;
            const span = anchor
              .map((token) => (token.kind === "text" ? token.value : "\n\n"))
              .join("");
            const anchored = balancedTrackedChanges(span) && wrappableSpan(span, 0, span.length);
            tokens.splice(start, tokens.length - start, ...kept, {
              kind: "text",
              value: anchored ? `{==${span}==}${note}` : `${span}${note}`,
            });
            if (anchored) highlightCount++;
          }
          commentCount++;
          break;
        }
        case "t":
        case "delText":
          tokens.push({ kind: "text", value: element.textContent ?? "" });
          break;
        case "tab":
          tokens.push({ kind: "text", value: "\t" });
          break;
        case "noBreakHyphen":
          tokens.push({ kind: "text", value: "\u2011" });
          break;
        case "br":
        case "cr":
          tokens.push({ kind: "text", value: "\n" });
          break;
        default:
          walk(element);
      }
    }
  };
  walk(body);

  // Malformed exports occasionally omit a range end. Keep the prose untouched
  // and preserve the comment as an unanchored point at EOF instead of allowing
  // an open range to consume the rest of the document. A comment with no range
  // at all (a bare w:commentReference, or nothing) lands there too.
  for (const id of new Set([...openComments.keys(), ...comments.keys()])) {
    if (placedComments.has(id)) continue;
    tokens.push({ kind: "text", value: formatComment(comments, id) });
    commentCount++;
  }

  const paragraphs: string[] = [];
  let current = "";
  for (const token of tokens) {
    if (token.kind === "text") current += token.value;
    else {
      if (current.trim()) paragraphs.push(token.prefix + current.trimEnd());
      current = "";
    }
  }
  if (current.trim()) paragraphs.push(current.trimEnd());
  if (paragraphs.length === 0) throw new Error("document has no text to import");

  return {
    markdown: `${paragraphs.join("\n\n")}\n`,
    comments: commentCount,
    highlights: highlightCount,
  };
}
