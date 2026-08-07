import { GFM, parser as baseMarkdownParser } from "@lezer/markdown";

import { markdownLiteralRanges, positionInRanges } from "./markdownLiteralRanges";
import type { PrintStyle } from "./viewSettings";

export type PrintReferenceSide = "left" | "right";

export interface PrintReference {
  id: string;
  kind: "footnote" | "quote";
  label: string;
  markdown: string;
  side: PrintReferenceSide | null;
}

export interface PrintRow {
  markdown: string;
  references: PrintReference[];
}

export interface PrintDocumentModel {
  style: PrintStyle;
  footnoteLabels: Record<string, string>;
  rows: PrintRow[];
  endnotes: PrintReference[];
}

interface SourceLine {
  from: number;
  to: number;
  text: string;
}

interface FootnoteDefinition {
  id: string;
  markdown: string;
  from: number;
  to: number;
  firstReference: number;
  label: string;
}

interface InternalReference extends PrintReference {
  sourcePosition: number;
}

interface InternalRow extends PrintRow {
  from: number;
  to: number;
  references: InternalReference[];
}

const markdownParser = baseMarkdownParser.configure(GFM);
const SHORT_QUOTE_LIMIT = 140;

function sourceLines(source: string): SourceLine[] {
  const chunks = source.match(/[^\n]*(?:\n|$)/g) ?? [];
  const lines: SourceLine[] = [];
  let from = 0;
  for (const chunk of chunks) {
    if (!chunk) continue;
    const rawText = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
    lines.push({ from, to: from + chunk.length, text: rawText.replace(/\r$/, "") });
    from += chunk.length;
  }
  return lines;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstFootnoteReference(
  source: string,
  id: string,
  protectedRanges: ReturnType<typeof markdownLiteralRanges>,
): number {
  const matcher = new RegExp(`\\[\\^${escapeRegExp(id)}\\]`, "g");
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(source)) !== null) {
    if (!positionInRanges(match.index, protectedRanges)) return match.index;
  }
  return Number.POSITIVE_INFINITY;
}

function extractFootnotes(source: string): {
  body: string;
  definitions: Omit<FootnoteDefinition, "firstReference" | "label">[];
} {
  const lines = sourceLines(source);
  const protectedRanges = markdownLiteralRanges(source);
  const definitions: Omit<FootnoteDefinition, "firstReference" | "label">[] = [];

  for (let i = 0; i < lines.length; ) {
    const match = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(lines[i].text);
    if (!match || positionInRanges(lines[i].from, protectedRanges)) {
      i += 1;
      continue;
    }

    const markdown = [match[2]];
    const from = lines[i].from;
    let to = lines[i].to;
    let next = i + 1;
    while (next < lines.length) {
      const continuation = /^(?: {4}|\t)(.*)$/.exec(lines[next].text);
      if (continuation) {
        markdown.push(continuation[1]);
        to = lines[next].to;
        next += 1;
        continue;
      }
      if (lines[next].text.trim() === "") {
        let lookahead = next + 1;
        while (lookahead < lines.length && lines[lookahead].text.trim() === "") {
          lookahead += 1;
        }
        if (lookahead < lines.length && /^(?: {4}|\t)/.test(lines[lookahead].text)) {
          markdown.push("");
          to = lines[next].to;
          next += 1;
          continue;
        }
      }
      break;
    }

    definitions.push({
      id: match[1],
      markdown: markdown.join("\n").trimEnd(),
      from,
      to,
    });
    i = next;
  }

  // Keep every offset stable for the Markdown parse and reference attachment.
  // Only definition bytes are blanked; line breaks remain where they were.
  // Lezer and String#slice use UTF-16 code-unit offsets. split("") preserves
  // those offsets; spreading would collapse surrogate pairs and shift every
  // range after an emoji or other non-BMP character.
  const body = source.split("");
  for (const definition of definitions) {
    for (let i = definition.from; i < definition.to; i += 1) {
      if (body[i] !== "\n" && body[i] !== "\r") body[i] = " ";
    }
  }
  return { body: body.join(""), definitions };
}

function stripQuoteMarkers(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^ {0,3}>[ \t]?/, ""))
    .join("\n")
    .trim();
}

function quoteIsShort(markdown: string): boolean {
  const visible = stripQuoteMarkers(markdown).replace(/\s+/g, " ").trim();
  return visible.length > 0 && visible.length <= SHORT_QUOTE_LIMIT;
}

function assignInitialReferenceSides(rows: InternalRow[]) {
  for (const reference of rows.flatMap((row) => row.references)) reference.side = "right";
  for (const row of rows) {
    row.references.sort((a, b) => a.sourcePosition - b.sourcePosition);
  }
}

/** Odd-numbered book pages use the right outer margin; even pages use the left.
 * `pageIndex` is zero-based because DOM layout math is zero-based. */
export function referenceSideForPage(
  pageIndex: number,
  alternateSides: boolean,
): PrintReferenceSide {
  return alternateSides && pageIndex % 2 === 1 ? "left" : "right";
}

/** Prepare accepted Markdown for browser print without changing source bytes.
 * Simple mode keeps the article flow and collects definitions as endnotes.
 * Tufte mode moves footnotes and short blockquotes into a conservative side rib;
 * long quotations stay in the article so they cannot overflow a narrow margin. */
export function preparePrintDocument(
  markdown: string,
  style: PrintStyle,
  alternateSides: boolean,
): PrintDocumentModel {
  const { body, definitions: rawDefinitions } = extractFootnotes(markdown);
  const protectedRanges = markdownLiteralRanges(body);
  const definitions: FootnoteDefinition[] = rawDefinitions
    .map((definition) => ({
      ...definition,
      firstReference: firstFootnoteReference(body, definition.id, protectedRanges),
      label: "",
    }))
    .sort(
      (a, b) =>
        a.firstReference - b.firstReference ||
        a.from - b.from,
    );
  definitions.forEach((definition, index) => {
    definition.label = String(index + 1);
  });
  const footnoteLabels = Object.fromEntries(
    definitions.map((definition) => [definition.id, definition.label]),
  );

  const rows: InternalRow[] = [];
  let quoteCount = 0;
  const documentNode = markdownParser.parse(body).topNode;
  for (let block = documentNode.firstChild; block; block = block.nextSibling) {
    const blockMarkdown = body.slice(block.from, block.to);
    if (style === "tufte" && block.name === "Blockquote" && quoteIsShort(blockMarkdown)) {
      quoteCount += 1;
      const reference: InternalReference = {
        id: `quote-${quoteCount}`,
        kind: "quote",
        label: "Quote",
        markdown: stripQuoteMarkers(blockMarkdown),
        side: null,
        sourcePosition: block.from,
      };
      const previous = rows.at(-1);
      if (previous) {
        previous.to = block.to;
        previous.references.push(reference);
      } else {
        rows.push({
          from: block.from,
          to: block.to,
          markdown: "",
          references: [reference],
        });
      }
      continue;
    }
    rows.push({
      from: block.from,
      to: block.to,
      markdown: blockMarkdown,
      references: [],
    });
  }

  const endnotes: InternalReference[] = [];
  for (const definition of definitions) {
    const reference: InternalReference = {
      id: definition.id,
      kind: "footnote",
      label: definition.label,
      markdown: definition.markdown,
      side: null,
      sourcePosition: Number.isFinite(definition.firstReference)
        ? definition.firstReference
        : definition.from,
    };
    if (style === "simple") {
      endnotes.push(reference);
      continue;
    }
    const row =
      rows.find(
        (candidate) =>
          reference.sourcePosition >= candidate.from &&
          reference.sourcePosition <= candidate.to,
      ) ?? rows.at(-1);
    if (row) row.references.push(reference);
    else {
      rows.push({
        from: reference.sourcePosition,
        to: reference.sourcePosition,
        markdown: "",
        references: [reference],
      });
    }
  }

  if (style === "tufte") assignInitialReferenceSides(rows);

  return {
    style,
    footnoteLabels,
    rows: rows.map(({ markdown: rowMarkdown, references }) => ({
      markdown: rowMarkdown,
      references: references.map(({ sourcePosition: _sourcePosition, ...reference }) => reference),
    })),
    endnotes: endnotes.map(({ sourcePosition: _sourcePosition, ...reference }) => reference),
  };
}
