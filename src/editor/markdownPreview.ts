// ── Markdown live-preview ─────────────────────────────────────────────────────
// Makes the buffer LOOK rendered while staying plain text. Inline preview has two
// responsibilities, split into two ViewPlugins (each with its OWN RangeSetBuilder)
// because a mark and a replace over the SAME node range crash a single builder:
//
//   1. STYLE plugin  — Decoration.mark to size headings, embolden strong, etc.,
//      plus a line decoration giving blockquote lines a left rule.
//   2. HIDE plugin    — Decoration.replace (empty) to hide the syntax markers
//      (#, **, _, `, >, list bullets, link [] () ) UNLESS the cursor/selection is
//      on that line, in which case the markers are revealed for editing.
//
// Tables and safe HTML blocks use a third component: a StateField provides block
// replacements (which ViewPlugins cannot). Tables expose focused cell inputs;
// the global source toggle removes every preview replacement deliberately.
//
// Both only walk `view.visibleRanges` and rebuild on doc / viewport / selection
// changes. CriticMarkup nodes are skipped entirely — criticMarkupView.ts owns
// those. Every builder receives ranges in increasing `from` order (syntaxTree's
// enter() is pre-order left-to-right, which already satisfies this for the marks;
// the hide plugin sorts defensively where mixed sources could interleave).

import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Range } from "@codemirror/state";

import {
  nextMarkdownTableCell,
  markdownTableCellRange,
  tablePreviewForNode,
  updateMarkdownTableCell,
} from "./markdownTable";
import type {
  MarkdownTableCellAddress,
  MarkdownTableModel,
  TableAlignment,
} from "./markdownTable";
import { appendRichBlocks, appendRichInline } from "./richMarkdown";
import { appendMath, findMathRanges } from "./math";
import { standaloneInsertionTokens } from "./standaloneInsertion";
import { assetStatus, imageFailureText } from "./imageFailure";
import { acceptedMarkdown, scanTokens } from "../lib/criticmarkup";
import { isComment } from "../lib/types";

export const TABLE_CELL_COMMENT_EVENT = "acm:table-cell-comment";

export function tableCellReviewState(value: string, cellFrom: number): {
  markdown: string;
  comments: { from: number; author: string | null; body: string }[];
} {
  const comments = scanTokens(value)
    .filter(isComment)
    .map((comment) => ({
      from: cellFrom + comment.from,
      author: comment.author,
      body: comment.body,
    }));
  const accepted = acceptedMarkdown(value);
  return {
    markdown: accepted.ok ? accepted.markdown : value,
    comments,
  };
}

// CriticMarkup delimiter nodes we hide (like Markdown markers) so suggestions read
// as rendered prose: green inserted text, struck deletions, etc. — not raw `{++…++}`.
// Comment markup is NOT here: criticMarkupView.ts replaces the whole `{>>…<<}` with a
// 💬 bubble. Revealed on the active line for editing, same as Markdown markers.
const CM_DELIM_NODES = new Set<string>([
  "CMInsertOpen",
  "CMInsertClose",
  "CMDeleteOpen",
  "CMDeleteClose",
  // Highlight delimiters are now a single (nesting-aware) mark node — see
  // criticMarkupParser.ts. Hiding it covers clean, stacked, and ins/del-content
  // highlights uniformly (no more raw `{==`/`==}` leak).
  "CMHighlightMark",
  "CMSubOpen",
  "CMSubClose",
]);

/** Renders the substitution `~>` as a tidy arrow when the line isn't active. */
class SubArrowWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-sub-arrow";
    s.textContent = "→";
    return s;
  }
}
const subArrowDeco = Decoration.replace({ widget: new SubArrowWidget() });

/** Renders a real bullet in place of a `-`/`*`/`+` list marker (off the active line),
 *  so unordered lists read as lists, not flat paragraphs. */
class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-bullet";
    s.textContent = "•";
    return s;
  }
}
const bulletDeco = Decoration.replace({ widget: new BulletWidget() });

/** Renders an inline `![alt](url)` as the actual image when the line isn't
 *  active (issue #3); the cursor on the line reveals the raw syntax, same as
 *  every other marker. Relative urls are served doc-relative via /api/asset;
 *  a failed load swaps to a compact "missing" chip so a bad path is visible.
 *  eq() by url+alt so selection-driven rebuilds reuse the DOM — otherwise the
 *  <img> would be recreated (and flicker/refetch) on every keystroke. */
class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.url === this.url && other.alt === this.alt;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-image";
    const img = document.createElement("img");
    const src = /^(https?:|data:)/i.test(this.url)
      ? this.url
      : `/api/asset?path=${encodeURIComponent(this.url)}`;
    img.src = src;
    img.alt = this.alt;
    // Dragging a rendered image would put its /api/asset URL on the drag — a
    // re-drop would insert a broken duplicate ref (or navigate). Not a gesture.
    img.draggable = false;
    img.onerror = () => {
      wrap.textContent = imageFailureText(this.url, null);
      wrap.className = "cm-md-image cm-md-image-missing";
      // A refused path (403) is "blocked", not "missing" (#64).
      void assetStatus(src).then((answer) => {
        if (answer?.status === 403) wrap.textContent = imageFailureText(this.url, 403, answer.body);
      });
    };
    wrap.appendChild(img);
    return wrap;
  }
  // Let the editor handle clicks: they place the cursor at the image, which
  // makes the line active → raw syntax reveals for editing.
  ignoreEvent() {
    return false;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly latex: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.latex === this.latex && other.display === this.display;
  }
  toDOM() {
    const wrap = document.createElement(this.display ? "div" : "span");
    wrap.className = "cm-math-widget";
    if (!appendMath(wrap, this.latex, this.display)) wrap.textContent = this.latex;
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function tableCellKey(address: MarkdownTableCellAddress): string {
  return `${address.section}:${address.row}:${address.column}`;
}

export function renderedTableCellSelector(
  tableFrom: number,
  address: MarkdownTableCellAddress,
): string {
  return `[data-table-from="${tableFrom}"] [data-table-cell="${tableCellKey(address)}"]`;
}

function focusRenderedTableCell(
  view: EditorView,
  tableFrom: number,
  address: MarkdownTableCellAddress | null,
  boundaryAnchor: number | null = null,
) {
  if (!address && boundaryAnchor === null) return;
  setTimeout(() => {
    if (address) {
      const cell = view.dom.querySelector<HTMLElement>(
        renderedTableCellSelector(tableFrom, address),
      );
      if (cell) {
        (cell.querySelector<HTMLElement>(".cm-md-table-edit") ?? cell).focus();
        return;
      }
    }
    if (boundaryAnchor === null) return;
    const anchor = Math.max(0, Math.min(boundaryAnchor, view.state.doc.length));
    view.dispatch({ selection: { anchor }, scrollIntoView: true });
    view.focus();
  }, 0);
}

/** Renders a parsed GFM table as an interactive block. A focused cell reveals
 * its Markdown in a native input; committing replaces the complete table in one
 * aligned CodeMirror transaction, so undo restores the exact previous source. */
class TableWidget extends WidgetType {
  constructor(readonly model: MarkdownTableModel) {
    super();
  }
  eq(other: TableWidget) {
    return other.model.from === this.model.from && other.model.source === this.model.source;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    wrap.dataset.tableFrom = String(this.model.from);
    wrap.setAttribute("contenteditable", "false");

    const table = document.createElement("table");
    table.className = "cm-md-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    this.model.header.forEach((value, index) => {
      headRow.appendChild(
        tableCell(view, this.model, "th", value, this.model.alignments[index], {
          section: "header",
          row: 0,
          column: index,
        }, markdownTableCellRange(this.model, { section: "header", row: 0, column: index })),
      );
    });
    head.appendChild(headRow);
    table.appendChild(head);

    if (this.model.rows.length > 0) {
      const body = document.createElement("tbody");
      for (const [rowIndex, row] of this.model.rows.entries()) {
        const rowElement = document.createElement("tr");
        row.forEach((value, index) => {
          rowElement.appendChild(
            tableCell(view, this.model, "td", value, this.model.alignments[index], {
              section: "body",
              row: rowIndex,
              column: index,
            }, markdownTableCellRange(this.model, { section: "body", row: rowIndex, column: index })),
          );
        });
        body.appendChild(rowElement);
      }
      table.appendChild(body);
    }
    wrap.appendChild(table);

    return wrap;
  }
}

class HtmlBlockWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: HtmlBlockWidget) {
    return other.source === this.source;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-html-block";
    wrap.setAttribute("contenteditable", "false");
    appendRichBlocks(wrap, this.source);
    return wrap;
  }
}

class CodeBlockWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: CodeBlockWidget) {
    return other.source === this.source;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-code-block";
    wrap.setAttribute("contenteditable", "false");
    appendRichBlocks(wrap, this.source);
    return wrap;
  }
}

function tableCell(
  view: EditorView,
  model: MarkdownTableModel,
  tag: "th" | "td",
  value: string,
  alignment: TableAlignment | undefined,
  address: MarkdownTableCellAddress,
  sourceRange: { from: number; to: number } | null,
): HTMLTableCellElement {
  const cell = document.createElement(tag);
  const renderRich = () => {
    cell.replaceChildren();
    const review = tableCellReviewState(value, sourceRange?.from ?? model.from);
    const content = document.createElement("span");
    content.className = "cm-md-table-cell-content";
    appendRichInline(content, review.markdown);
    cell.appendChild(content);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "cm-md-table-action cm-md-table-edit";
    edit.setAttribute("aria-label", `Edit table cell: ${review.markdown || "empty"}`);
    edit.title = "Edit this table cell";
    edit.textContent = "✎";
    edit.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      activate();
    });
    cell.appendChild(edit);

    if (review.comments.length > 0) {
      cell.classList.add("cm-md-table-cell-commented");
      for (const comment of review.comments) {
        const marker = document.createElement("button");
        marker.type = "button";
        marker.className = "cm-md-table-action cm-md-table-comment-marker";
        marker.dataset.commentFrom = String(comment.from);
        marker.setAttribute("aria-label", `Open comment by ${comment.author ?? "anonymous"}`);
        marker.title = comment.body;
        marker.textContent = "●";
        cell.appendChild(marker);
      }
    } else if (sourceRange && sourceRange.to > sourceRange.from && value.trim()) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "cm-md-table-action cm-md-table-comment-add";
      add.setAttribute("aria-label", `Comment on table cell: ${value}`);
      add.title = "Comment on this table cell";
      add.textContent = "+";
      add.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        cell.dispatchEvent(
          new CustomEvent(TABLE_CELL_COMMENT_EVENT, {
            bubbles: true,
            detail: sourceRange,
          }),
        );
      });
      cell.appendChild(add);
    }
  };
  renderRich();
  if (alignment) cell.style.textAlign = alignment;
  cell.dataset.tableCell = tableCellKey(address);
  cell.title = "Click to edit; Cmd/Ctrl-click a link to open it";

  const activate = (selection: { start: number; end: number } | null = null) => {
    if (cell.querySelector("input")) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cm-md-table-cell-input";
    input.value = value;
    input.setAttribute("aria-label", "Table cell Markdown");
    cell.replaceChildren(input);
    let finished = false;

    const finish = (
      next: MarkdownTableCellAddress | null = null,
      boundary: "before" | "after" | null = null,
    ) => {
      if (finished) return;
      finished = true;
      const replacement = updateMarkdownTableCell(model, address, input.value);
      if (replacement === null || replacement === model.source) {
        renderRich();
        focusRenderedTableCell(
          view,
          model.from,
          next,
          boundary === "before" ? model.from : boundary === "after" ? model.to : null,
        );
        return;
      }
      const anchor = boundary === "before" ? model.from : model.from + replacement.length;
      view.dispatch({
        changes: { from: model.from, to: model.to, insert: replacement },
        selection: { anchor },
        scrollIntoView: true,
      });
      focusRenderedTableCell(
        view,
        model.from,
        next,
        boundary === null ? null : anchor,
      );
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finished = true;
        renderRich();
        cell.querySelector<HTMLElement>(".cm-md-table-edit")?.focus();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        finish(address);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const direction = event.shiftKey ? -1 : 1;
        const next = nextMarkdownTableCell(model, address, direction);
        finish(next, next ? null : direction < 0 ? "before" : "after");
      }
    });
    input.addEventListener("blur", () => finish());
    input.focus();
    if (selection) {
      input.setSelectionRange(selection.start, selection.end);
      requestAnimationFrame(() => {
        if (!input.isConnected) return;
        input.setSelectionRange(selection.start, selection.end);
        input.scrollLeft = 0;
      });
    } else input.select();
  };

  cell.addEventListener("click", (event) => {
    if ((event.target as HTMLElement | null)?.closest?.(".cm-md-table-action")) return;
    const targetLink = (event.target as HTMLElement | null)?.closest?.("a") ?? null;
    const action = tableCellPointerAction(
      Boolean(targetLink),
      event.metaKey || event.ctrlKey,
    );
    if (action === "follow-link") return;
    event.preventDefault();
    activate(tableCellLinkSelection(value, targetLink?.textContent ?? null));
  });
  return cell;
}

export function tableCellPointerAction(
  targetIsLink: boolean,
  modified: boolean,
): "edit" | "follow-link" {
  return targetIsLink && modified ? "follow-link" : "edit";
}

export function tableCellLinkSelection(
  value: string,
  linkText: string | null,
): { start: number; end: number } | null {
  if (!linkText) return null;
  const marker = `[${linkText}]`;
  const markerStart = value.indexOf(marker);
  if (markerStart < 0) return null;
  return { start: markerStart + 1, end: markerStart + 1 + linkText.length };
}

// Marks that, when present as a node's child, denote raw markdown syntax we hide.
// NB: ListMark is NOT here — it's special-cased in buildHide (rendered as a bullet
// for unordered lists, left visible for ordered) rather than hidden outright.
const HIDDEN_MARK_NODES = new Set<string>([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "QuoteMark",
  "LinkMark", // the [, ], (, ) brackets and url delimiters
  "URL", // bare url text inside ( ) — hide so only link text shows
  // NB: fenced-code nodes (CodeInfo/CodeText/CodeMark fences) are intentionally
  // NOT hidden — hiding CodeText would make code blocks vanish. Inline code keeps
  // its backticks hidden via CodeMark above.
]);

// Container nodes whose presence we style with a mark class.
function isSetextHeading(name: string | null): boolean {
  return name === "SetextHeading1" || name === "SetextHeading2";
}

export function headingPreviewClass(name: string, active: boolean): string | null {
  // A Setext heading spans two source lines. Keep both lines visibly raw while
  // the cursor is anywhere inside them, so typing `---` as a separator cannot
  // silently restyle the preceding prose. Moving away deliberately settles the
  // valid Markdown back into rich heading preview.
  if (active && isSetextHeading(name)) return null;
  switch (name) {
    case "ATXHeading1":
    case "SetextHeading1":
      return "cm-md-h1";
    case "ATXHeading2":
    case "SetextHeading2":
      return "cm-md-h2";
    case "ATXHeading3":
      return "cm-md-h3";
    case "ATXHeading4":
      return "cm-md-h4";
    case "ATXHeading5":
      return "cm-md-h5";
    case "ATXHeading6":
      return "cm-md-h6";
    default:
      return null;
  }
}

/** Whether a heading marker should be hidden in rich preview. Kept separate from
 * the DOM decoration builder so active Setext editing has a direct regression
 * contract: the underline belongs to the whole two-line heading, not just its
 * own line. */
export function shouldHideHeadingMark(
  parentName: string | null,
  headingActive: boolean,
  markActive: boolean,
): boolean {
  return !markActive && !(headingActive && isSetextHeading(parentName));
}

function inlineMarkClass(name: string): string | null {
  switch (name) {
    case "StrongEmphasis":
      return "cm-md-strong";
    case "Emphasis":
      return "cm-md-em";
    case "InlineCode":
      return "cm-md-code";
    case "Link":
      return "cm-md-link";
    case "Blockquote":
      return "cm-md-quote";
    // ListItem text stays normal colour — the bullet (rendered in buildHide) carries
    // the "this is a list" signal, not a muted body.
    default:
      return null;
  }
}

// ── Underline (<u>…</u>, #38) ────────────────────────────────────────────────
// Markdown has no underline, so ACM stores it as inline HTML. Lezer parses each
// tag as its own HTMLTag node; pair an exact `<u>` with the next `</u>` under the
// same parent (a paragraph, heading or CriticMarkup span), so an unclosed or
// cross-span tag stays raw text rather than underlining half a document.
interface InlineTag {
  from: number;
  to: number;
  text: string;
  parent: string;
}

interface UnderlineSpan {
  open: { from: number; to: number };
  close: { from: number; to: number };
}

function inlineTag(
  node: { from: number; to: number; node: { parent: { from: number; name: string } | null } },
  text: string,
): InlineTag {
  const parent = node.node.parent;
  return { from: node.from, to: node.to, text, parent: parent ? `${parent.name}@${parent.from}` : "" };
}

function pairUnderlineTags(tags: readonly InlineTag[]): UnderlineSpan[] {
  const spans: UnderlineSpan[] = [];
  const openByParent = new Map<string, InlineTag[]>();
  for (const tag of [...tags].sort((a, b) => a.from - b.from)) {
    const stack = openByParent.get(tag.parent) ?? [];
    if (/^<u>$/i.test(tag.text)) {
      stack.push(tag);
      openByParent.set(tag.parent, stack);
    } else if (/^<\/u\s*>$/i.test(tag.text)) {
      const open = stack.pop();
      if (open) spans.push({ open: { from: open.from, to: open.to }, close: { from: tag.from, to: tag.to } });
    }
  }
  return spans;
}

/** True when the editor is focused AND a selection range touches the line
 *  containing [from,to). Gated on focus so an unfocused document renders fully
 *  (no stray markers revealed by the default cursor-at-0). */
function selectionOnRange(view: EditorView, from: number, to: number): boolean {
  if (!view.hasFocus) return false;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  for (const r of view.state.selection.ranges) {
    if (r.to >= startLine.from && r.from <= endLine.to) return true;
  }
  return false;
}

const hiddenMark = Decoration.replace({});

export function previewStyleNeedsRebuild(change: {
  docChanged: boolean;
  viewportChanged: boolean;
  selectionSet: boolean;
  focusChanged: boolean;
  treeChanged: boolean;
}): boolean {
  return (
    change.docChanged ||
    change.viewportChanged ||
    change.selectionSet ||
    change.focusChanged ||
    change.treeChanged
  );
}

const underlineMark = Decoration.mark({ class: "cm-md-underline" });

// ── STYLE plugin ──────────────────────────────────────────────────────────────
export function buildStyle(view: EditorView): DecorationSet {
  // Collect ranges then sort by (from, startSide) so the builder never receives
  // out-of-order input — heading marks and inline marks can interleave.
  const ranges: Range<Decoration>[] = [];
  const standaloneInsertions = standaloneInsertionTokens(view.state);
  const quoteLineClass = Decoration.line({ class: "cm-md-quote-line" });
  const tags: InlineTag[] = [];

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: vFrom,
      to: vTo,
      enter: (node) => {
        const name = node.name;
        if (
          standaloneInsertions.some(
            (insertion) => insertion.from <= node.from && node.to <= insertion.to,
          )
        ) {
          return false;
        }
        // CriticMarkup's own view colours its spans; Markdown inside a highlight,
        // insertion or deletion still gets its inline style (an anchored code
        // span stays code, #85). A comment body parses as one opaque node.
        // Inactive tables are one block widget; active tables deliberately stay
        // raw, without nested preview styling obscuring the editable source.
        if (name === "Table" || name === "FencedCode" || name === "CodeBlock") return false;

        const hClass = headingPreviewClass(
          name,
          selectionOnRange(view, node.from, node.to),
        );
        if (hClass) {
          ranges.push(Decoration.mark({ class: hClass }).range(node.from, node.to));
          return;
        }
        if (name === "HTMLTag") {
          tags.push(inlineTag(node, view.state.doc.sliceString(node.from, node.to)));
          return;
        }
        const iClass = inlineMarkClass(name);
        if (iClass && node.to > node.from) {
          ranges.push(Decoration.mark({ class: iClass }).range(node.from, node.to));
        }
        if (name === "Blockquote") {
          // Apply a left-rule line decoration to each line the quote spans.
          let pos = node.from;
          while (pos <= node.to) {
            const line = view.state.doc.lineAt(pos);
            ranges.push(quoteLineClass.range(line.from));
            if (line.to + 1 > node.to) break;
            pos = line.to + 1;
          }
        }
      },
    });
  }

  for (const span of pairUnderlineTags(tags)) {
    if (span.close.from > span.open.to) {
      ranges.push(underlineMark.range(span.open.to, span.close.from));
    }
  }

  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

const styleViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildStyle(view);
    }
    update(u: ViewUpdate) {
      // syntaxTree check: the parse is async on large docs — rebuild when the
      // tree extends, or styling freezes at the first-paint parse boundary.
      if (
        previewStyleNeedsRebuild({
          docChanged: u.docChanged,
          viewportChanged: u.viewportChanged,
          selectionSet: u.selectionSet,
          focusChanged: u.focusChanged,
          treeChanged: syntaxTree(u.state) !== syntaxTree(u.startState),
        })
      ) {
        this.decorations = buildStyle(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ── HIDE plugin ─────────────────────────────────────────────────────────────
export function buildHide(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const standaloneInsertions = standaloneInsertionTokens(view.state);
  const tags: InlineTag[] = [];

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: vFrom,
      to: vTo,
      enter: (node) => {
        const name = node.name;
        if (
          standaloneInsertions.some(
            (insertion) => insertion.from <= node.from && node.to <= insertion.to,
          )
        ) {
          return false;
        }
        // CriticMarkup stays rendered ALWAYS — its delimiters never reveal on the
        // active line (you interact via the dot/✓/✗ controls, not the raw braces),
        // so clicking a line keeps the WYSIWYG view. Comment markup is replaced
        // wholesale by criticMarkupView; here we just hide suggestion/highlight
        // delimiters and render the substitution `~>` as →.
        if (name === "CMComment") return false;
        if (name === "CMSubArrow") {
          ranges.push(subArrowDeco.range(node.from, node.to));
          return false;
        }
        if (CM_DELIM_NODES.has(name)) {
          if (node.from !== node.to) ranges.push(hiddenMark.range(node.from, node.to));
          return false;
        }
        if (name.startsWith("CM")) return; // container node — descend to its delimiters

        // Table rendering lives in a StateField because block replacements may
        // not be supplied by a ViewPlugin. Never emit nested hide ranges: when
        // active, every cell and delimiter must remain raw and editable.
        if (name === "Table" || name === "FencedCode" || name === "CodeBlock") return false;

        // Images: replace the whole `![alt](url)` with the rendered image (off
        // the active line). `return false` throughout — the node's LinkMark/URL
        // children must not ALSO emit hide ranges under (or instead of) the
        // replacement. Reference-style images (no inline URL child) stay raw.
        if (name === "Image") {
          if (selectionOnRange(view, node.from, node.to)) return false; // reveal raw for editing
          const urlNode = node.node.getChild("URL");
          if (!urlNode) return false;
          const url = view.state.doc.sliceString(urlNode.from, urlNode.to);
          const alt = /^!\[([^\]]*)\]/.exec(
            view.state.doc.sliceString(node.from, node.to),
          )?.[1] ?? "";
          ranges.push(
            Decoration.replace({ widget: new ImageWidget(url, alt) }).range(node.from, node.to),
          );
          return false;
        }

        // List markers: render a bullet for unordered (-, *, +); leave ordered (1.)
        // visible. Revealed raw on the active line for editing. (Not in HIDDEN_MARK_NODES.)
        if (name === "ListMark") {
          if (node.from === node.to) return;
          if (selectionOnRange(view, node.from, node.to)) return;
          const mark = view.state.doc.sliceString(node.from, node.to);
          if (/^[-*+]$/.test(mark)) ranges.push(bulletDeco.range(node.from, node.to));
          return;
        }

        if (name === "HTMLTag") {
          tags.push(inlineTag(node, view.state.doc.sliceString(node.from, node.to)));
          return;
        }

        if (!HIDDEN_MARK_NODES.has(name)) return;
        if (node.from === node.to) return;
        // Only hide a URL when it's the target of an inline [text](url) link; a
        // bare/autolink URL in prose must stay visible (GFM emits a top-level URL
        // node for those too).
        if (name === "URL" && node.node.parent?.name !== "Link") return;
        // Reveal markers on the active line so they can be edited. Setext
        // HeaderMark needs the parent heading's active state too because its
        // title and underline occupy different lines.
        const markActive = selectionOnRange(view, node.from, node.to);
        if (name !== "HeaderMark" && markActive) return;
        if (name === "HeaderMark") {
          const parent = node.node.parent;
          if (
            !shouldHideHeadingMark(
              parent?.name ?? null,
              parent ? selectionOnRange(view, parent.from, parent.to) : markActive,
              markActive,
            )
          ) {
            return;
          }
          // Also hide the single space after `#`/`##` so the heading text renders
          // flush — otherwise the hidden marker leaves a leading space (looks like
          // the line isn't really a heading).
          const to =
            view.state.doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
          ranges.push(hiddenMark.range(node.from, to));
          return;
        }
        ranges.push(hiddenMark.range(node.from, node.to));
      },
    });
  }

  // Underline tags hide like `**`: off the active line only, so the raw tags
  // come back for editing when the cursor is on their line.
  for (const span of pairUnderlineTags(tags)) {
    if (selectionOnRange(view, span.open.from, span.close.to)) continue;
    ranges.push(hiddenMark.range(span.open.from, span.open.to));
    ranges.push(hiddenMark.range(span.close.from, span.close.to));
  }

  ranges.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

const hideViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHide(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
        this.decorations = buildHide(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    // Replace decorations that hide content must be provided as decorations the
    // view treats specially; supplying via the plugin's `decorations` is fine for
    // replace marks (they participate in the standard decoration set).
  },
);

interface MathPreviewState {
  focused: boolean;
  decorations: DecorationSet;
}

const mathFocusChanged = StateEffect.define<boolean>();

function stateSelectionOnRange(
  state: EditorState,
  focused: boolean,
  from: number,
  to: number,
): boolean {
  if (!focused) return false;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);
  return state.selection.ranges.some(
    (range) => range.to >= startLine.from && range.from <= endLine.to,
  );
}

function buildMathPreview(state: EditorState, focused: boolean): DecorationSet {
  const source = state.doc.toString();
  const tableRanges: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Table") {
        tableRanges.push({ from: node.from, to: node.to });
        return false;
      }
      return;
    },
  });
  const standaloneInsertions = standaloneInsertionTokens(state);
  const ranges = findMathRanges(source)
    .filter(
      (math) =>
        !tableRanges.some((range) => range.from <= math.from && math.to <= range.to) &&
        !standaloneInsertions.some(
          (insertion) => insertion.from <= math.from && math.to <= insertion.to,
        ) &&
        !stateSelectionOnRange(state, focused, math.from, math.to),
    )
    .map((math) =>
      Decoration.replace({
        widget: new MathWidget(math.latex, math.display),
        block: math.display,
        inclusive: false,
      }).range(math.from, math.to),
    );

  ranges.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.value);
  return builder.finish();
}

const mathPreviewField = StateField.define<MathPreviewState>({
  create(state) {
    return { focused: false, decorations: buildMathPreview(state, false) };
  },
  update(value, transaction) {
    let focused = value.focused;
    for (const effect of transaction.effects) {
      if (effect.is(mathFocusChanged)) focused = effect.value;
    }
    if (
      transaction.docChanged ||
      transaction.selection !== undefined ||
      focused !== value.focused ||
      syntaxTree(transaction.state) !== syntaxTree(transaction.startState)
    ) {
      return { focused, decorations: buildMathPreview(transaction.state, focused) };
    }
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.from(field, (value) => () => value.decorations),
  ],
});

const mathFocusExtension = EditorView.focusChangeEffect.of((_state, focusing) =>
  mathFocusChanged.of(focusing)
);

function buildBlockPreviews(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (
        (node.name === "FencedCode" || node.name === "CodeBlock") &&
        node.node.parent?.name === "Document"
      ) {
        ranges.push(
          Decoration.replace({
            widget: new CodeBlockWidget(state.doc.sliceString(node.from, node.to)),
            block: true,
            inclusive: false,
          }).range(node.from, node.to),
        );
        return false;
      }
      if (node.name === "HTMLBlock" && node.node.parent?.name === "Document") {
        ranges.push(
          Decoration.replace({
            widget: new HtmlBlockWidget(state.doc.sliceString(node.from, node.to)),
            block: true,
            inclusive: false,
          }).range(node.from, node.to),
        );
        return false;
      }
      if (node.name === "Table") {
        const model = tablePreviewForNode(state.doc, node.node);
        if (model) {
          ranges.push(
            Decoration.replace({
              widget: new TableWidget(model),
              block: true,
              inclusive: false,
            }).range(node.from, node.to),
          );
        }
        return false;
      }
      return;
    },
  });

  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.value);
  return builder.finish();
}

const blockPreviewField = StateField.define<DecorationSet>({
  create: buildBlockPreviews,
  update(value, transaction) {
    if (
      transaction.docChanged ||
      syntaxTree(transaction.state) !== syntaxTree(transaction.startState)
    ) {
      return buildBlockPreviews(transaction.state);
    }
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.from(field, (decorations) => () => decorations),
  ],
});

/** The live-preview extension: inline styling/hiding plus block table previews. */
export const markdownPreview: Extension = [
  styleViewPlugin,
  hideViewPlugin,
  mathFocusExtension,
  mathPreviewField,
  blockPreviewField,
];
