// ── CriticMarkup grammar for @lezer/markdown ──────────────────────────────────
// An INLINE-parser extension (modelled on @lezer/markdown's Strikethrough /
// Superscript / Emoji parsers) that teaches the Markdown parser the five
// CriticMarkup constructs. The CodeMirror decoration layer (criticMarkupView.ts)
// then reads these nodes from the syntax tree to render colours + widgets.
//
// Why a lezer extension and not regex: the parser is incremental, nest-aware,
// and handles half-typed markup gracefully (a parser that can't find its closing
// delimiter returns -1, so `{++` with no close just renders as plain text).
//
// Each construct gets one container node plus child "mark" nodes for the opening
// / closing delimiters (and, for substitution, the `~>` arrow). The marks let the
// view hide the raw delimiters while keeping the inner text styled.

import type { InlineContext, InlineParser, MarkdownConfig } from "@lezer/markdown";
import { Tag } from "@lezer/highlight";

// Character codes (avoids per-call string allocation in the hot parse loop).
const BRACE_OPEN = 123; // {
const BRACE_CLOSE = 125; // }
const PLUS = 43; // +
const MINUS = 45; // -
const TILDE = 126; // ~
const EQUALS = 61; // =
const GT = 62; // >
const LT = 60; // <

/**
 * Highlight tags for the five constructs, keyed by construct name. Attached to
 * the container nodes via each NodeSpec's `style`, so a HighlightStyle (theme.ts)
 * could colour them. Decoration.mark in the view is the primary colouring path;
 * these tags exist for completeness and any future syntax-highlight consumers.
 */
export const critTags = {
  insert: Tag.define(),
  delete: Tag.define(),
  substitute: Tag.define(),
  highlight: Tag.define(),
  comment: Tag.define(),
} as const;

/**
 * True if any construct's opening delimiter (`{++`, `{--`, `{~~`, `{==`, `{>>`)
 * appears in [start, end). Used to reject an unbalanced/stray open that would
 * otherwise swallow a later construct — mirrors the lib scanTokens no-swallow
 * guard so the editor and review surfaces agree on token boundaries.
 */
function hasNestedOpen(cx: InlineContext, start: number, end: number): boolean {
  for (let i = start; i < end - 1; i++) {
    if (cx.char(i) !== BRACE_OPEN) continue;
    const a = cx.char(i + 1);
    const b = cx.char(i + 2);
    if (
      (a === PLUS && b === PLUS) ||
      (a === MINUS && b === MINUS) ||
      (a === TILDE && b === TILDE) ||
      (a === EQUALS && b === EQUALS) ||
      (a === GT && b === GT)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Find the document-relative position of a two-character closing delimiter
 * (e.g. `++`, `--`, `==`, `~~`) followed immediately by `}`. Returns the
 * position of the first delimiter char, or -1 if the close is absent within
 * this inline section. `start` is where the search begins.
 */
function findClose(cx: InlineContext, start: number, delim: number): number {
  // The closing delimiter is two `delim` chars then `}`. Scan to cx.end.
  for (let i = start; i < cx.end - 2; i++) {
    if (
      cx.char(i) === delim &&
      cx.char(i + 1) === delim &&
      cx.char(i + 2) === BRACE_CLOSE
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Build a parser for the simple `{XXcontentXX}` shape (insert/delete/highlight),
 * where `XX` is a doubled delimiter char. Emits:
 *   <Node>  <NodeMarkOpen>{XX</NodeMarkOpen> content <NodeMarkClose>XX}</NodeMarkClose> </Node>
 */
function makeSimpleParser(
  delim: number,
  node: string,
  markOpen: string,
  markClose: string,
): InlineParser["parse"] {
  return (cx, next, pos) => {
    // Must open with `{` then the doubled delimiter: `{++`, `{--`, `{==`.
    if (next !== BRACE_OPEN || cx.char(pos + 1) !== delim || cx.char(pos + 2) !== delim) {
      return -1;
    }
    const contentStart = pos + 3;
    const closeAt = findClose(cx, contentStart, delim);
    if (closeAt < 0 || closeAt < contentStart) return -1;
    if (hasNestedOpen(cx, contentStart, closeAt)) return -1; // unbalanced: don't swallow
    const end = closeAt + 3; // past `XX}`
    const open = cx.elt(markOpen, pos, contentStart);
    const close = cx.elt(markClose, closeAt, end);
    return cx.addElement(cx.elt(node, pos, end, [open, close]));
  };
}

// ── Insert: {++ ... ++} ───────────────────────────────────────────────────────
const parseInsert = makeSimpleParser(PLUS, "CMInsert", "CMInsertOpen", "CMInsertClose");

// ── Delete: {-- ... --} ───────────────────────────────────────────────────────
const parseDelete = makeSimpleParser(MINUS, "CMDelete", "CMDeleteOpen", "CMDeleteClose");

// ── Highlight: {== ... ==} — NESTING-AWARE via lezer delimiters ───────────────
// Highlights are comment anchors, and the Google-Docs .docx export stacks/embeds
// them: a span with N comments nests N highlights (`{=={==x==}{>>c<<}==}…`), and an
// anchor may wrap tracked changes (`{==text {++ins++} {--del--}==}`). A simple
// "claim {== … first ==}" parser (makeSimpleParser) can't model that — it bails on
// nested opens and the outer/inner delimiters leak as raw `{==` / `==}`. Modelling
// `{==`/`==}` as a paired DELIMITER (exactly how GFM Strikethrough handles `~~`)
// makes highlights nest correctly AND lets inner constructs (comments, ins/del)
// parse as children, so they still render. The mark `CMHighlightMark` is hidden by
// the view, same as the old open/close marks. (Single-block only — lezer inline
// parsing is block-scoped, so a highlight spanning a blank line stays unresolved;
// those multi-paragraph anchors are handled upstream by the converter.)
const HighlightDelim = { resolve: "CMHighlight", mark: "CMHighlightMark" };
const parseHighlight: InlineParser["parse"] = (cx, next, pos) => {
  // Opening `{==`.
  if (next === BRACE_OPEN && cx.char(pos + 1) === EQUALS && cx.char(pos + 2) === EQUALS) {
    return cx.addDelimiter(HighlightDelim, pos, pos + 3, true, false);
  }
  // Closing `==}`.
  if (next === EQUALS && cx.char(pos + 1) === EQUALS && cx.char(pos + 2) === BRACE_CLOSE) {
    return cx.addDelimiter(HighlightDelim, pos, pos + 3, false, true);
  }
  return -1;
};

// ── Substitution: {~~ old ~> new ~~} ──────────────────────────────────────────
// The `~>` arrow splits old (struck) from new (green). We emit the arrow as its
// own mark node so the view can split styling at it.
const parseSubstitute: InlineParser["parse"] = (cx, next, pos) => {
  if (next !== BRACE_OPEN || cx.char(pos + 1) !== TILDE || cx.char(pos + 2) !== TILDE) {
    return -1;
  }
  const oldStart = pos + 3;
  const closeAt = findClose(cx, oldStart, TILDE);
  if (closeAt < 0 || closeAt < oldStart) return -1;
  if (hasNestedOpen(cx, oldStart, closeAt)) return -1; // unbalanced: don't swallow
  // Locate the `~>` arrow strictly before the closing `~~}`.
  let arrowAt = -1;
  for (let i = oldStart; i < closeAt; i++) {
    if (cx.char(i) === TILDE && cx.char(i + 1) === GT) {
      arrowAt = i;
      break;
    }
  }
  if (arrowAt < 0) return -1; // a `{~~ ... ~~}` with no arrow is not a substitution
  const end = closeAt + 3; // past `~~}`
  const open = cx.elt("CMSubOpen", pos, oldStart);
  const arrow = cx.elt("CMSubArrow", arrowAt, arrowAt + 2);
  const close = cx.elt("CMSubClose", closeAt, end);
  return cx.addElement(cx.elt("CMSubstitute", pos, end, [open, arrow, close]));
};

// ── Comment: {>> ... <<} (optionally `{>>@author: text<<}`) ───────────────────
const parseComment: InlineParser["parse"] = (cx, next, pos) => {
  if (next !== BRACE_OPEN || cx.char(pos + 1) !== GT || cx.char(pos + 2) !== GT) {
    return -1;
  }
  const bodyStart = pos + 3;
  // Closing delimiter is `<<}`.
  let closeAt = -1;
  for (let i = bodyStart; i < cx.end - 2; i++) {
    if (cx.char(i) === LT && cx.char(i + 1) === LT && cx.char(i + 2) === BRACE_CLOSE) {
      closeAt = i;
      break;
    }
  }
  if (closeAt < 0 || closeAt < bodyStart) return -1;
  if (hasNestedOpen(cx, bodyStart, closeAt)) return -1; // unbalanced: don't swallow
  const end = closeAt + 3; // past `<<}`
  const open = cx.elt("CMCommentOpen", pos, bodyStart);
  const close = cx.elt("CMCommentClose", closeAt, end);
  return cx.addElement(cx.elt("CMComment", pos, end, [open, close]));
};

/**
 * The CriticMarkup MarkdownConfig: defines the container + mark nodes and
 * registers the five inline parsers BEFORE Emphasis so the brace constructs
 * claim their content before markdown emphasis/strikethrough can. GFM
 * Strikethrough is intentionally NOT enabled by the host (its `~~` collides with
 * substitution); the leading `{` disambiguates our constructs.
 */
export const CriticMarkup: MarkdownConfig = {
  defineNodes: [
    { name: "CMInsert", style: critTags.insert },
    { name: "CMInsertOpen" },
    { name: "CMInsertClose" },
    { name: "CMDelete", style: critTags.delete },
    { name: "CMDeleteOpen" },
    { name: "CMDeleteClose" },
    { name: "CMSubstitute", style: critTags.substitute },
    { name: "CMSubOpen" },
    { name: "CMSubArrow" },
    { name: "CMSubClose" },
    // Highlight is delimiter-based (nesting-aware): one mark node for both `{==`
    // and `==}`, the container `CMHighlight` is built by lezer's delimiter resolver.
    { name: "CMHighlight", style: { "CMHighlight/...": critTags.highlight } },
    { name: "CMHighlightMark" },
    { name: "CMComment", style: critTags.comment },
    { name: "CMCommentOpen" },
    { name: "CMCommentClose" },
  ],
  parseInline: [
    { name: "CMInsert", parse: parseInsert, before: "Emphasis" },
    { name: "CMDelete", parse: parseDelete, before: "Emphasis" },
    { name: "CMSubstitute", parse: parseSubstitute, before: "Emphasis" },
    { name: "CMHighlight", parse: parseHighlight, before: "Emphasis" },
    { name: "CMComment", parse: parseComment, before: "Emphasis" },
  ],
};
