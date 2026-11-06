import { GFM, parser as baseMarkdownParser } from "@lezer/markdown";

export interface SourceRange {
  from: number;
  to: number;
  /** Where a selection touching this range must widen to (a link's `[`), when it
   *  starts before `from`. Only set with the `wholeLinks` option. */
  widenFrom?: number;
  /** A block literal (fenced or indented code, an HTML block): nothing may be
   *  anchored in it, and a comment goes on its own paragraph after it. */
  block?: boolean;
}

const markdownParser = baseMarkdownParser.configure(GFM);
/** Lezer node names whose bytes are literal (code, HTML, URLs, escapes). */
export const LITERAL_NODES: ReadonlySet<string> = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "HTMLTag",
  "URL",
  "Autolink",
  "Escape",
]);
const BLOCK_NODES = new Set(["FencedCode", "CodeBlock", "HTMLBlock"]);
const RAW_CODE_ELEMENT = /<(code|pre|script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Markdown regions whose bytes are examples/transport rather than review prose.
 * CriticMarkup-shaped text inside these ranges must stay literal for export and
 * reference discovery. */
export function markdownLiteralRanges(
  source: string,
  options: { wholeLinks?: boolean } = {},
): SourceRange[] {
  const ranges: SourceRange[] = [];
  markdownParser.parse(source).iterate({
    enter(node) {
      // For annotation placement a link's destination is not a span of its own:
      // wrapping or splitting `](url)`, `]()` or `][ref]` breaks the link, so a
      // selection touching it widens to the whole link. The link text stays prose.
      if (options.wholeLinks && (node.name === "Link" || node.name === "Image")) {
        const textEnd = node.node.getChildren("LinkMark")[1];
        if (textEnd && node.to > textEnd.to) {
          ranges.push({ from: textEnd.from, to: node.to, widenFrom: node.from });
        }
        return; // descend: the link text may hold code spans of its own
      }
      if (!LITERAL_NODES.has(node.name)) return;
      ranges.push({ from: node.from, to: node.to, block: BLOCK_NODES.has(node.name) || undefined });
      return false;
    },
  });

  for (const match of source.matchAll(RAW_CODE_ELEMENT)) {
    const from = match.index;
    ranges.push({ from, to: from + match[0].length, block: match[0].includes("\n") || undefined });
  }

  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: SourceRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
      if (range.widenFrom !== undefined) {
        previous.widenFrom = Math.min(previous.widenFrom ?? previous.from, range.widenFrom);
      }
      if (range.block) previous.block = true;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function positionInRanges(position: number, ranges: readonly SourceRange[]): boolean {
  return ranges.some((range) => position >= range.from && position < range.to);
}
