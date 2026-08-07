import { useLayoutEffect, useMemo, useRef } from "react";

import { appendRichBlocks } from "../editor/richMarkdown";
import type { AcceptedMarkdownResult, MarkupDiagnostic } from "../lib/criticmarkup";
import { preparePrintDocument, referenceSideForPage } from "../lib/printDocument";
import type { PrintDocumentModel, PrintReference, PrintReferenceSide } from "../lib/printDocument";
import type { PrintStyle } from "../lib/viewSettings";

export type PrintRenderState =
  | { ok: true; model: PrintDocumentModel }
  | { ok: false; diagnostics: MarkupDiagnostic[] };

function clearElement(element: HTMLElement) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function createElement(parent: HTMLElement, tag: string, className?: string): HTMLElement {
  const element = parent.ownerDocument.createElement(tag) as unknown as HTMLElement;
  if (className) element.setAttribute("class", className);
  return element;
}

function appendText(parent: HTMLElement, text: string) {
  parent.appendChild(parent.ownerDocument.createTextNode(text));
}

function replaceFootnoteReferences(root: HTMLElement, labels: Record<string, string>) {
  const visit = (parent: HTMLElement) => {
    for (let child = parent.firstChild; child; ) {
      const next = child.nextSibling;
      if (child.nodeType === 1) {
        const element = child as unknown as HTMLElement;
        const tag = element.tagName.toLowerCase();
        if (tag !== "code" && tag !== "pre") visit(element);
      } else if (child.nodeType === 3) {
        const value = child.nodeValue ?? "";
        const matcher = /\[\^([^\]\s]+)\]/g;
        let match: RegExpExecArray | null;
        let cursor = 0;
        let replaced = false;
        while ((match = matcher.exec(value)) !== null) {
          const label = labels[match[1]];
          if (!label) continue;
          replaced = true;
          if (match.index > cursor) {
            parent.insertBefore(
              parent.ownerDocument.createTextNode(value.slice(cursor, match.index)),
              child,
            );
          }
          const sup = createElement(parent, "sup", "acm-print-footnote-ref");
          appendText(sup, label);
          parent.insertBefore(sup, child);
          cursor = match.index + match[0].length;
        }
        if (replaced) {
          if (cursor < value.length) {
            parent.insertBefore(parent.ownerDocument.createTextNode(value.slice(cursor)), child);
          }
          parent.removeChild(child);
        }
      }
      child = next;
    }
  };
  visit(root);
}

interface ProtectedFootnoteLiteral {
  placeholder: string;
  text: string;
}

function protectEscapedFootnoteReferences(markdown: string): {
  markdown: string;
  literals: ProtectedFootnoteLiteral[];
} {
  const literals: ProtectedFootnoteLiteral[] = [];
  return {
    markdown: markdown.replace(/(\\+)(\[\^[^\]\s]+\])/g, (match, slashes: string, text: string) => {
      if (slashes.length % 2 === 0) return match;
      const placeholder = `\uE000acm-footnote-literal-${literals.length}\uE001`;
      literals.push({ placeholder, text });
      return `${slashes.slice(0, -1)}${placeholder}`;
    }),
    literals,
  };
}

function restoreProtectedFootnoteReferences(
  root: HTMLElement,
  literals: ProtectedFootnoteLiteral[],
) {
  if (literals.length === 0) return;
  const visit = (parent: HTMLElement) => {
    for (let child = parent.firstChild; child; ) {
      const next = child.nextSibling;
      if (child.nodeType === 1) {
        visit(child as unknown as HTMLElement);
      } else if (child.nodeType === 3 && child.nodeValue) {
        let value = child.nodeValue;
        for (const literal of literals) {
          value = value.replaceAll(literal.placeholder, literal.text);
        }
        if (value !== child.nodeValue) {
          parent.replaceChild(parent.ownerDocument.createTextNode(value), child);
        }
      }
      child = next;
    }
  };
  visit(root);
}

function appendPrintMarkdown(
  parent: HTMLElement,
  markdown: string,
  labels: Record<string, string>,
) {
  const protectedSource = protectEscapedFootnoteReferences(markdown);
  appendRichBlocks(parent, protectedSource.markdown);
  replaceFootnoteReferences(parent, labels);
  restoreProtectedFootnoteReferences(parent, protectedSource.literals);
}

function preparePrintImages(root: HTMLElement) {
  // The print surface is intentionally off-screen, so lazy images may never
  // intersect the viewport and therefore never load. Sweep the complete surface
  // rather than relying on any one Markdown append path.
  for (const image of Array.from(root.getElementsByTagName("img"))) {
    image.setAttribute("loading", "eager");
    image.setAttribute("fetchpriority", "high");
  }
}

/** Wait until every print image has either loaded or failed. A bounded wait
 * keeps one dead remote URL from trapping the user before the native dialog;
 * returned sources are the images that were still pending at the deadline. */
export async function waitForPrintImages(
  root: HTMLElement,
  timeoutMs = 5_000,
): Promise<string[]> {
  preparePrintImages(root);
  const pending = new Set(
    Array.from(root.getElementsByTagName("img")).filter(
      (image) => !(image as unknown as HTMLImageElement).complete,
    ) as unknown as HTMLImageElement[],
  );
  if (pending.size === 0) return [];

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      for (const image of pending) {
        image.removeEventListener("load", onSettled);
        image.removeEventListener("error", onSettled);
      }
      if (timer) clearTimeout(timer);
    };
    const finish = (sources: string[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(sources);
    };
    const onSettled = (event: Event) => {
      pending.delete(event.currentTarget as HTMLImageElement);
      if (pending.size === 0) finish([]);
    };
    for (const image of pending) {
      image.addEventListener("load", onSettled, { once: true });
      image.addEventListener("error", onSettled, { once: true });
    }
    // An image can complete between the initial `.complete` filter and listener
    // registration. Recheck after listeners attach so that race neither waits
    // for the full timeout nor reports a loaded image as missing.
    for (const image of [...pending]) {
      if (image.complete) pending.delete(image);
    }
    if (pending.size === 0) {
      finish([]);
      return;
    }
    timer = setTimeout(
      () => finish([...pending].map((image) => image.currentSrc || image.src || "image")),
      timeoutMs,
    );
  });
}

function appendReference(
  parent: HTMLElement,
  reference: PrintReference,
  labels: Record<string, string>,
) {
  const note = createElement(
    parent,
    "section",
    `acm-print-reference acm-print-reference--${reference.kind}`,
  );
  const label = createElement(note, "div", "acm-print-reference-label");
  appendText(label, reference.label);
  note.appendChild(label);
  const body = createElement(note, "div", "acm-print-reference-body");
  appendPrintMarkdown(body, reference.markdown, labels);
  note.appendChild(body);
  parent.appendChild(note);
}

function appendRib(
  row: HTMLElement,
  references: PrintReference[],
  side: PrintReferenceSide,
  labels: Record<string, string>,
) {
  const onSide = references.filter((reference) => reference.side === side);
  if (onSide.length === 0) return;
  const rib = createElement(row, "aside", `acm-print-rib acm-print-rib--${side}`);
  for (const reference of onSide) appendReference(rib, reference, labels);
  row.appendChild(rib);
}

function renderReadyDocument(root: HTMLElement, model: PrintDocumentModel) {
  root.setAttribute("class", `acm-print-root acm-print-root--${model.style}`);
  root.setAttribute("data-print-state", "ready");
  root.setAttribute("data-print-style", model.style);

  const article = createElement(root, "article", "acm-print-article");
  for (const rowModel of model.rows) {
    const row = createElement(
      article,
      "section",
      `acm-print-row${rowModel.markdown ? "" : " acm-print-row--references-only"}`,
    );
    if (model.style === "tufte") {
      // Ribs precede the main block so print CSS can float them into the outer
      // margins without making a short paragraph row as tall as its notes.
      appendRib(row, rowModel.references, "left", model.footnoteLabels);
      appendRib(row, rowModel.references, "right", model.footnoteLabels);
    }
    const main = createElement(row, "div", "acm-print-main");
    if (rowModel.markdown) appendPrintMarkdown(main, rowModel.markdown, model.footnoteLabels);
    row.appendChild(main);
    article.appendChild(row);
  }

  if (model.endnotes.length > 0) {
    const notes = createElement(article, "section", "acm-print-endnotes");
    const heading = createElement(notes, "h2");
    appendText(heading, "Notes");
    notes.appendChild(heading);
    const list = createElement(notes, "ol");
    for (const reference of model.endnotes) {
      const item = createElement(list, "li");
      item.setAttribute("value", reference.label);
      const body = createElement(item, "div");
      appendPrintMarkdown(body, reference.markdown, model.footnoteLabels);
      item.appendChild(body);
      list.appendChild(item);
    }
    notes.appendChild(list);
    article.appendChild(notes);
  }

  root.appendChild(article);
}

function renderBlockedDocument(root: HTMLElement, diagnostics: MarkupDiagnostic[]) {
  root.setAttribute("class", "acm-print-root acm-print-root--blocked");
  root.setAttribute("data-print-state", "blocked");
  root.removeAttribute("data-print-style");
  const notice = createElement(root, "section", "acm-print-blocked");
  const heading = createElement(notice, "h1");
  appendText(heading, "Printing paused");
  notice.appendChild(heading);
  const body = createElement(notice, "p");
  appendText(
    body,
    `Fix ${diagnostics.length} markup issue${diagnostics.length === 1 ? "" : "s"} before exporting this document.`,
  );
  notice.appendChild(body);
  const detail = createElement(notice, "p", "acm-print-blocked-detail");
  appendText(detail, "ACM withheld the document so review delimiters cannot leak into the PDF.");
  notice.appendChild(detail);
  root.appendChild(notice);
}

/** Imperative so the same safe renderer is directly regression-tested and the
 * hidden print surface never depends on serialising the live editor DOM. */
export function renderPrintDocument(root: HTMLElement, state: PrintRenderState) {
  // `positionTufteReferenceRibs` sets an explicit page width before printing.
  // Rendering a different style into the same hidden surface must drop that
  // measurement so Simple and blocked output use their own print CSS width.
  root.removeAttribute("style");
  clearElement(root);
  if (state.ok) renderReadyDocument(root, state.model);
  else renderBlockedDocument(root, state.diagnostics);
  preparePrintImages(root);
}

const CSS_PX_PER_MM = 96 / 25.4;
const TUFTE_PAGE_CONTENT_WIDTH_MM = 210 - 12 - 16;
const TUFTE_PAGE_CONTENT_HEIGHT_PX = (297 - 16 - 20) * CSS_PX_PER_MM;

/** Reposition complete reference groups after print media has laid out the page.
 * Keeping a row's notes together prevents a single page from mixing left/right
 * ribs; the page index chooses the book's outer margin. */
export function positionTufteReferenceRibs(
  root: HTMLElement,
  alternateSides: boolean,
  pageHeightPx = TUFTE_PAGE_CONTENT_HEIGHT_PX,
) {
  // The hidden print surface otherwise inherits the browser viewport width when
  // beforeprint fires. The PDF then reflows it to the A4 page box, changing row
  // heights and therefore page parity after the side was chosen. Measure and print
  // at the exact Tufte page-area width (both left/right pages are 182mm wide).
  root.style.width = `${TUFTE_PAGE_CONTENT_WIDTH_MM}mm`;
  const rootTop = root.getBoundingClientRect().top;
  for (const row of root.querySelectorAll<HTMLElement>(".acm-print-row")) {
    const rib = row.querySelector<HTMLElement>(".acm-print-rib");
    if (!rib) continue;
    const rowTop = Math.max(0, row.getBoundingClientRect().top - rootTop);
    const pageIndex = Math.floor(rowTop / pageHeightPx);
    const side = referenceSideForPage(pageIndex, alternateSides);
    rib.classList.toggle("acm-print-rib--left", side === "left");
    rib.classList.toggle("acm-print-rib--right", side === "right");
  }
}

export default function PrintDocument({
  result,
  style,
  alternateSides,
}: {
  result: AcceptedMarkdownResult;
  style: PrintStyle;
  alternateSides: boolean;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const state = useMemo<PrintRenderState>(
    () =>
      result.ok
        ? {
            ok: true,
            model: preparePrintDocument(result.markdown, style, alternateSides),
          }
        : result,
    [alternateSides, result, style],
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    renderPrintDocument(root, state);
    const onBeforePrint = () => {
      if (state.ok && state.model.style === "tufte") {
        positionTufteReferenceRibs(root, alternateSides);
      }
    };
    window.addEventListener("beforeprint", onBeforePrint);
    return () => window.removeEventListener("beforeprint", onBeforePrint);
  }, [alternateSides, state]);

  return <section id="acm-print-document" ref={rootRef} aria-hidden="true" />;
}
