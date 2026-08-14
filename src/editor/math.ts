import katex from "katex";
import { DOMParser } from "@xmldom/xmldom";
import type { Element as XmlElement, Node as XmlNode } from "@xmldom/xmldom";

import { markdownLiteralRanges, positionInRanges } from "../lib/markdownLiteralRanges";

export interface MathRange {
  from: number;
  to: number;
  latex: string;
  display: boolean;
}

function escapedAt(source: string, index: number): boolean {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && source[at] === "\\"; at -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** Find dollar-delimited LaTeX outside Markdown literals. The single-dollar
 * closing rule rejects whitespace-before and digit-after delimiters, which keeps
 * ordinary price prose such as "$5 and $6" visible instead of pairing it. */
export function findMathRanges(source: string): MathRange[] {
  const literals = markdownLiteralRanges(source);
  const ranges: MathRange[] = [];

  for (let from = 0; from < source.length; from += 1) {
    if (
      source[from] !== "$" ||
      escapedAt(source, from) ||
      positionInRanges(from, literals)
    ) {
      continue;
    }
    const display = source[from + 1] === "$";
    const marker = display ? "$$" : "$";
    const innerFrom = from + marker.length;
    if (innerFrom >= source.length || (!display && /\s/.test(source[innerFrom]))) continue;

    let close = -1;
    for (let at = innerFrom; at < source.length; at += 1) {
      if (
        !source.startsWith(marker, at) ||
        escapedAt(source, at) ||
        positionInRanges(at, literals)
      ) {
        continue;
      }
      if (!display) {
        if (source[at - 1] === "$" || /\s/.test(source[at - 1] ?? "")) continue;
        if (/\d/.test(source[at + 1] ?? "")) continue;
      }
      close = at;
      break;
    }
    if (close < 0) continue;
    const latex = source.slice(innerFrom, close);
    if (!latex.trim()) continue;
    const to = close + marker.length;
    ranges.push({ from, to, latex, display });
    from = to - 1;
  }

  return ranges;
}

const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";

function appendTrustedNode(parent: HTMLElement, node: XmlNode, mathNamespace = false) {
  if (node.nodeType === 3) {
    parent.appendChild(parent.ownerDocument.createTextNode(node.nodeValue ?? ""));
    return;
  }
  if (node.nodeType !== 1) return;

  const source = node as XmlElement;
  const tag = source.tagName.toLowerCase();
  const inMath = mathNamespace || tag === "math";
  const element = (inMath
    ? parent.ownerDocument.createElementNS(MATHML_NAMESPACE, tag)
    : parent.ownerDocument.createElement(tag)) as unknown as HTMLElement;
  for (let index = 0; index < source.attributes.length; index += 1) {
    const attribute = source.attributes.item(index);
    if (attribute) element.setAttribute(attribute.name, attribute.value);
  }
  for (let child = source.firstChild; child; child = child.nextSibling) {
    appendTrustedNode(element, child, inMath);
  }
  parent.appendChild(element);
}

/** Render trusted KaTeX output into either a browser DOM or the XML DOM used by
 * renderer tests. Returns false only when KaTeX or fragment parsing fails. */
export function appendMath(parent: HTMLElement, latex: string, display: boolean): boolean {
  let html: string;
  try {
    html = katex.renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      output: "htmlAndMathml",
    });
  } catch {
    return false;
  }

  const parsed = new DOMParser().parseFromString(
    `<div data-acm-math-root="true">${html}</div>`,
    "text/html",
  );
  const root = parsed.documentElement;
  if (!root) return false;
  for (let child = root.firstChild; child; child = child.nextSibling) {
    appendTrustedNode(parent, child);
  }
  return true;
}
