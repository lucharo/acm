import type { SyntaxNode } from "@lezer/common";
import { GFM, parser as baseMarkdownParser } from "@lezer/markdown";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type {
  Document as XmlDocument,
  Element as XmlElement,
  Node as XmlNode,
} from "@xmldom/xmldom";

import { extractMarkdownTable } from "./markdownTable";
import { appendMath, findMathRanges } from "./math";

const markdownParser = baseMarkdownParser.configure(GFM);

const SAFE_HTML_TAGS = new Set([
  "a",
  "article",
  "b",
  "blockquote",
  "br",
  "code",
  "details",
  "del",
  "div",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const DANGEROUS_HTML_TAGS = new Set([
  "applet",
  "audio",
  "base",
  "embed",
  "form",
  "iframe",
  "link",
  "meta",
  "object",
  "script",
  "style",
  "svg",
  "template",
  "video",
]);

function appendText(parent: HTMLElement, text: string) {
  if (text) parent.appendChild(parent.ownerDocument.createTextNode(text));
}

function directChildren(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
  return children;
}

/** Return a browser-safe href, or null for executable/invalid schemes. */
export function safeLinkHref(href: string): string | null {
  const value = href.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const protocol = new URL(value, "https://acm.invalid/").protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:"
      ? value
      : null;
  } catch {
    return null;
  }
}

function safeImageSource(source: string): string | null {
  const value = source.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const protocol = new URL(value, "https://acm.invalid/").protocol;
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function copyNumericAttribute(
  source: XmlElement,
  target: HTMLElement,
  name: "colspan" | "rowspan" | "start" | "width" | "height",
) {
  const value = source.getAttribute(name);
  if (value && /^\d{1,4}$/.test(value) && Number(value) > 0) {
    target.setAttribute(name, value);
  }
}

function appendSanitizedHtmlNode(
  parent: HTMLElement,
  node: XmlNode,
  markdownText: boolean,
  preserveUnsafe: boolean,
): boolean {
  if (node.nodeType === 3) {
    const value = node.nodeValue ?? "";
    if (!markdownText && !value.trim()) return false;
    if (markdownText) appendRichInline(parent, value, { html: true });
    else appendText(parent, value);
    return value.length > 0;
  }
  if (node.nodeType !== 1) return false;

  const source = node as XmlElement;
  const tag = source.tagName.toLowerCase();
  if (DANGEROUS_HTML_TAGS.has(tag)) {
    if (preserveUnsafe) {
      const visible = new XMLSerializer()
        .serializeToString(source)
        .replace(/ xmlns(?::\w+)?="[^"]*"/g, "");
      appendText(parent, visible);
      return true;
    }
    return false;
  }
  if (!SAFE_HTML_TAGS.has(tag)) {
    let appended = false;
    for (let child = source.firstChild; child; child = child.nextSibling) {
      appended =
        appendSanitizedHtmlNode(parent, child, markdownText, preserveUnsafe) || appended;
    }
    return appended;
  }

  if (tag === "a") {
    const href = safeLinkHref(source.getAttribute("href") ?? "");
    const link = parent.ownerDocument.createElement(href ? "a" : "span") as HTMLElement;
    if (href) {
      link.setAttribute("href", href);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      const title = source.getAttribute("title");
      if (title) link.setAttribute("title", title);
    }
    for (let child = source.firstChild; child; child = child.nextSibling) {
      appendSanitizedHtmlNode(link, child, markdownText, preserveUnsafe);
    }
    parent.appendChild(link);
    return true;
  }

  if (tag === "img") {
    const src = safeImageSource(source.getAttribute("src") ?? "");
    const alt = source.getAttribute("alt") ?? "";
    if (!src) {
      const fallback = parent.ownerDocument.createElement("span") as HTMLElement;
      appendText(fallback, alt || "unsafe image");
      parent.appendChild(fallback);
      return true;
    }
    const image = parent.ownerDocument.createElement("img") as HTMLElement;
    image.setAttribute("src", src);
    image.setAttribute("alt", alt);
    image.setAttribute("loading", "lazy");
    const title = source.getAttribute("title");
    if (title) image.setAttribute("title", title);
    copyNumericAttribute(source, image, "width");
    copyNumericAttribute(source, image, "height");
    parent.appendChild(image);
    return true;
  }

  const element = parent.ownerDocument.createElement(tag) as HTMLElement;
  if (tag === "table") element.setAttribute("class", "cm-rich-html-table");
  if (tag === "details" && source.hasAttribute("open")) element.setAttribute("open", "");
  if (tag === "td" || tag === "th") {
    copyNumericAttribute(source, element, "colspan");
    copyNumericAttribute(source, element, "rowspan");
  }
  if (tag === "ol") copyNumericAttribute(source, element, "start");
  for (let child = source.firstChild; child; child = child.nextSibling) {
    appendSanitizedHtmlNode(element, child, markdownText, preserveUnsafe);
  }
  parent.appendChild(element);
  return true;
}

function appendSafeHtmlFragment(
  parent: HTMLElement,
  source: string,
  markdownText: boolean,
): boolean {
  const errors: string[] = [];
  let parsed: XmlDocument;
  try {
    parsed = new DOMParser({
      onError(level, message) {
        if (
          level === "fatalError" ||
          /extra content|unclosed|mismatch|unexpected end/i.test(message)
        ) {
          errors.push(message);
        }
      },
    }).parseFromString(`<div data-acm-html-root="true">${source}</div>`, "text/html");
  } catch {
    return false;
  }
  if (errors.length > 0) return false;
  const root = parsed.documentElement;
  if (!root || root.tagName.toLowerCase() !== "div") return false;

  let appended = false;
  for (let child = root.firstChild; child; child = child.nextSibling) {
    appended = appendSanitizedHtmlNode(parent, child, markdownText, markdownText) || appended;
  }
  return appended;
}

const UNDERLINE_OPEN = /^<u>$/;
const UNDERLINE_CLOSE = /^<\/u>$/;

/** Index of the `</u>` that closes the `<u>` at `children[openIndex]`, or -1. */
function underlineCloseIndex(source: string, children: SyntaxNode[], openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < children.length; i += 1) {
    if (children[i].name !== "HTMLTag") continue;
    const text = source.slice(children[i].from, children[i].to);
    if (UNDERLINE_OPEN.test(text)) depth += 1;
    else if (UNDERLINE_CLOSE.test(text) && --depth === 0) return i;
  }
  return -1;
}

function appendInlineRange(
  parent: HTMLElement,
  source: string,
  container: SyntaxNode,
  from: number,
  to: number,
) {
  const children = directChildren(container).filter(
    (child) => child.from >= from && child.to <= to,
  );
  const maths = findMathRanges(source.slice(from, to)).map((range) => ({
    ...range,
    from: range.from + from,
    to: range.to + from,
  }));
  let cursor = from;
  let childIndex = 0;
  let mathIndex = 0;
  while (cursor < to) {
    while (children[childIndex]?.to <= cursor) childIndex += 1;
    while (maths[mathIndex]?.to <= cursor) mathIndex += 1;
    const child = children[childIndex];
    const math = maths[mathIndex];
    const nextFrom = Math.min(child?.from ?? to, math?.from ?? to);
    appendText(parent, source.slice(cursor, nextFrom));
    cursor = nextFrom;

    if (math && math.from <= (child?.from ?? to)) {
      if (!appendMath(parent, math.latex, math.display)) {
        appendText(parent, source.slice(math.from, math.to));
      }
      cursor = math.to;
      mathIndex += 1;
      continue;
    }
    if (child?.name === "HTMLTag" && UNDERLINE_OPEN.test(source.slice(child.from, child.to))) {
      // Markdown has no underline, so ACM writes <u>…</u> (#38). Draw a pair
      // whose tags share this container; an unclosed tag stays literal text.
      const closeIndex = underlineCloseIndex(source, children, childIndex);
      if (closeIndex >= 0) {
        const close = children[closeIndex];
        const underline = parent.ownerDocument.createElement("u") as unknown as HTMLElement;
        appendInlineRange(underline, source, container, child.to, close.from);
        parent.appendChild(underline);
        cursor = close.to;
        childIndex = closeIndex + 1;
        continue;
      }
    }
    if (child) {
      appendInlineNode(parent, source, child);
      cursor = child.to;
      childIndex += 1;
      continue;
    }
    break;
  }
  appendText(parent, source.slice(cursor, to));
}

function appendDelimitedInline(
  parent: HTMLElement,
  source: string,
  node: SyntaxNode,
  tag: "del" | "em" | "strong",
  markName = "EmphasisMark",
) {
  const marks = node.getChildren(markName);
  if (marks.length < 2) {
    appendText(parent, source.slice(node.from, node.to));
    return;
  }
  const element = parent.ownerDocument.createElement(tag) as unknown as HTMLElement;
  appendInlineRange(element, source, node, marks[0].to, marks.at(-1)!.from);
  parent.appendChild(element);
}

function appendInlineNode(parent: HTMLElement, source: string, node: SyntaxNode) {
  if (node.name === "Emphasis") {
    appendDelimitedInline(parent, source, node, "em");
    return;
  }
  if (node.name === "StrongEmphasis") {
    appendDelimitedInline(parent, source, node, "strong");
    return;
  }
  if (node.name === "Strikethrough") {
    appendDelimitedInline(parent, source, node, "del", "StrikethroughMark");
    return;
  }
  if (node.name === "InlineCode") {
    const marks = node.getChildren("CodeMark");
    if (marks.length < 2) {
      appendText(parent, source.slice(node.from, node.to));
      return;
    }
    const code = parent.ownerDocument.createElement("code") as unknown as HTMLElement;
    appendText(code, source.slice(marks[0].to, marks.at(-1)!.from));
    parent.appendChild(code);
    return;
  }
  if (node.name === "Link") {
    const marks = node.getChildren("LinkMark");
    const url = node.getChild("URL");
    if (marks.length < 4 || !url) {
      appendText(parent, source.slice(node.from, node.to));
      return;
    }
    const href = safeLinkHref(source.slice(url.from, url.to));
    if (!href) {
      appendText(parent, source.slice(node.from, node.to));
      return;
    }
    const link = parent.ownerDocument.createElement("a") as unknown as HTMLElement;
    link.setAttribute("href", href);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
    appendInlineRange(link, source, node, marks[0].to, marks[1].from);
    parent.appendChild(link);
    return;
  }
  if (node.name === "Image") {
    const url = node.getChild("URL");
    if (!url) {
      appendText(parent, source.slice(node.from, node.to));
      return;
    }
    const rawSource = source.slice(url.from, url.to);
    const safeSource = safeImageSource(rawSource);
    if (!safeSource) {
      appendText(parent, source.slice(node.from, node.to));
      return;
    }
    const image = parent.ownerDocument.createElement("img") as unknown as HTMLElement;
    const alt = /^!\[([^\]]*)\]/.exec(source.slice(node.from, node.to))?.[1] ?? "";
    image.setAttribute(
      "src",
      /^https?:/i.test(safeSource)
        ? safeSource
        : `/api/asset?path=${encodeURIComponent(safeSource)}`,
    );
    image.setAttribute("alt", alt);
    image.setAttribute("loading", "lazy");
    parent.appendChild(image);
    return;
  }
  if (node.name === "HardBreak") {
    parent.appendChild(parent.ownerDocument.createElement("br"));
    return;
  }
  if (node.name === "Escape") {
    const escaped = source.slice(node.from, node.to);
    appendText(parent, escaped.startsWith("\\") ? escaped.slice(1) : escaped);
    return;
  }
  appendText(parent, source.slice(node.from, node.to));
}

/** Append the supported inline Markdown subset using DOM APIs only. Unsupported
 * syntax and raw HTML remain visible text; no source string is assigned to HTML. */
export function appendRichInline(
  parent: HTMLElement,
  source: string,
  options: { html?: boolean } = {},
) {
  const documentNode = markdownParser.parse(source).topNode;
  const blocks = directChildren(documentNode);
  if (blocks.length !== 1 || blocks[0].name !== "Paragraph") {
    appendText(parent, source);
    return;
  }
  // Underline tags alone stay on the Markdown path, which pairs them itself, so
  // bold or italic around one span survives (the HTML-fragment path would split
  // a `**<u>key</u>**` beside a sibling <u> into raw stars).
  const otherHtml = blocks[0]
    .getChildren("HTMLTag")
    .some((tag) => {
      const text = source.slice(tag.from, tag.to);
      return !UNDERLINE_OPEN.test(text) && !UNDERLINE_CLOSE.test(text);
    });
  if (options.html && otherHtml) {
    if (!appendSafeHtmlFragment(parent, source, true)) appendText(parent, source);
    return;
  }
  appendInlineRange(parent, source, blocks[0], 0, source.length);
}

function appendParagraph(parent: HTMLElement, source: string, node: SyntaxNode) {
  const paragraph = parent.ownerDocument.createElement("p") as unknown as HTMLElement;
  appendRichInline(paragraph, source.slice(node.from, node.to), { html: true });
  parent.appendChild(paragraph);
}

function appendHeading(parent: HTMLElement, source: string, node: SyntaxNode) {
  const levelMatch = node.name.match(/(?:ATX|Setext)Heading([1-6])/);
  if (!levelMatch) {
    appendText(parent, source.slice(node.from, node.to));
    return;
  }
  const heading = parent.ownerDocument.createElement(
    `h${levelMatch[1]}`,
  ) as unknown as HTMLElement;
  const raw = source.slice(node.from, node.to);
  const content = node.name.startsWith("ATX")
    ? (/^#{1,6}[ \t]+([\s\S]*?)(?:[ \t]+#+[ \t]*)?$/.exec(raw)?.[1] ?? raw)
    : raw.slice(0, raw.lastIndexOf("\n"));
  appendRichInline(heading, content, { html: true });
  parent.appendChild(heading);
}

function appendListItem(parent: HTMLElement, source: string, node: SyntaxNode) {
  const item = parent.ownerDocument.createElement("li") as unknown as HTMLElement;
  for (const child of directChildren(node)) {
    if (child.name === "ListMark") continue;
    appendBlockNode(item, source, child);
  }
  parent.appendChild(item);
}

function appendList(parent: HTMLElement, source: string, node: SyntaxNode) {
  const tag = node.name === "OrderedList" ? "ol" : "ul";
  const list = parent.ownerDocument.createElement(tag) as unknown as HTMLElement;
  if (tag === "ol") {
    const firstItem = directChildren(node).find((child) => child.name === "ListItem");
    const mark = firstItem?.getChild("ListMark");
    const match = mark ? /^(\d{1,9})[.)]/.exec(source.slice(mark.from, mark.to)) : null;
    if (match && match[1] !== "1") list.setAttribute("start", match[1]);
  }
  for (const child of directChildren(node)) {
    if (child.name === "ListItem") appendListItem(list, source, child);
  }
  parent.appendChild(list);
}

function appendBlockquote(parent: HTMLElement, source: string, node: SyntaxNode) {
  const quote = parent.ownerDocument.createElement("blockquote") as unknown as HTMLElement;
  for (const child of directChildren(node)) {
    if (child.name === "QuoteMark") continue;
    appendBlockNode(quote, source, child);
  }
  parent.appendChild(quote);
}

function appendCodeBlock(parent: HTMLElement, source: string, node: SyntaxNode) {
  const pre = parent.ownerDocument.createElement("pre") as unknown as HTMLElement;
  const code = parent.ownerDocument.createElement("code") as unknown as HTMLElement;
  const codeText = node.getChild("CodeText");
  const codeInfo = node.getChild("CodeInfo");
  if (codeInfo) {
    const language = source.slice(codeInfo.from, codeInfo.to).trim().split(/\s+/, 1)[0];
    if (language) code.setAttribute("data-language", language);
  }
  appendText(code, codeText ? source.slice(codeText.from, codeText.to) : source.slice(node.from, node.to));
  pre.appendChild(code);
  parent.appendChild(pre);
}

function appendMarkdownTable(parent: HTMLElement, source: string, node: SyntaxNode): boolean {
  const model = extractMarkdownTable(
    { sliceString: (from, to) => source.slice(from, to) },
    node,
  );
  if (!model) return false;

  const table = parent.ownerDocument.createElement("table") as unknown as HTMLElement;
  table.setAttribute("class", "cm-rich-markdown-table");
  const head = parent.ownerDocument.createElement("thead") as unknown as HTMLElement;
  const headRow = parent.ownerDocument.createElement("tr") as unknown as HTMLElement;
  model.header.forEach((value, column) => {
    const cell = parent.ownerDocument.createElement("th") as unknown as HTMLElement;
    if (model.alignments[column]) cell.setAttribute("data-align", model.alignments[column]!);
    appendRichInline(cell, value, { html: true });
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  if (model.rows.length > 0) {
    const body = parent.ownerDocument.createElement("tbody") as unknown as HTMLElement;
    for (const row of model.rows) {
      const rowElement = parent.ownerDocument.createElement("tr") as unknown as HTMLElement;
      row.forEach((value, column) => {
        const cell = parent.ownerDocument.createElement("td") as unknown as HTMLElement;
        if (model.alignments[column]) cell.setAttribute("data-align", model.alignments[column]!);
        appendRichInline(cell, value, { html: true });
        rowElement.appendChild(cell);
      });
      body.appendChild(rowElement);
    }
    table.appendChild(body);
  }
  parent.appendChild(table);
  return true;
}

function appendBlockNode(parent: HTMLElement, source: string, node: SyntaxNode) {
  if (node.name === "Paragraph") {
    appendParagraph(parent, source, node);
    return;
  }
  if (/^(?:ATX|Setext)Heading[1-6]$/.test(node.name)) {
    appendHeading(parent, source, node);
    return;
  }
  if (node.name === "BulletList" || node.name === "OrderedList") {
    appendList(parent, source, node);
    return;
  }
  if (node.name === "Blockquote") {
    appendBlockquote(parent, source, node);
    return;
  }
  if (node.name === "FencedCode" || node.name === "CodeBlock") {
    appendCodeBlock(parent, source, node);
    return;
  }
  if (node.name === "HorizontalRule") {
    parent.appendChild(parent.ownerDocument.createElement("hr"));
    return;
  }
  if (node.name === "Table" && appendMarkdownTable(parent, source, node)) return;
  if (node.name === "HTMLBlock") {
    const raw = source.slice(node.from, node.to);
    if (appendSafeHtmlFragment(parent, raw, false)) return;
  }

  const unsupported = parent.ownerDocument.createElement("pre") as unknown as HTMLElement;
  unsupported.setAttribute("class", "cm-rich-unsupported");
  appendText(unsupported, source.slice(node.from, node.to));
  parent.appendChild(unsupported);
}

/** Render a conservative block Markdown subset for rich tracked additions. Every
 * node is built through DOM APIs; unsupported blocks stay inspectable as text. */
export function appendRichBlocks(parent: HTMLElement, source: string) {
  const documentNode = markdownParser.parse(source).topNode;
  const blocks = directChildren(documentNode);
  if (blocks.length === 0) {
    appendText(parent, source);
    return;
  }
  for (const block of blocks) appendBlockNode(parent, source, block);
}
