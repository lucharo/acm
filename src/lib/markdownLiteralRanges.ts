import { GFM, parser as baseMarkdownParser } from "@lezer/markdown";

export interface SourceRange {
  from: number;
  to: number;
}

const markdownParser = baseMarkdownParser.configure(GFM);
const LITERAL_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "HTMLTag",
  "URL",
  "Autolink",
  "Escape",
]);
const RAW_CODE_ELEMENT = /<(code|pre|script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Markdown regions whose bytes are examples/transport rather than review prose.
 * CriticMarkup-shaped text inside these ranges must stay literal for export and
 * reference discovery. */
export function markdownLiteralRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  markdownParser.parse(source).iterate({
    enter(node) {
      if (!LITERAL_NODES.has(node.name)) return;
      ranges.push({ from: node.from, to: node.to });
      return false;
    },
  });

  for (const match of source.matchAll(RAW_CODE_ELEMENT)) {
    const from = match.index;
    ranges.push({ from, to: from + match[0].length });
  }

  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: SourceRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function positionInRanges(position: number, ranges: readonly SourceRange[]): boolean {
  return ranges.some((range) => position >= range.from && position < range.to);
}
