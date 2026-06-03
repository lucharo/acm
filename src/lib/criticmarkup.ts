// ── CriticMarkup grammar + pure mutation logic ────────────────────────────────
// The single source of truth for ACM's file format. Used by:
//   • the editor (applySuggestion on ✓/✗ click)
//   • the sidebar / nav (scanTokens for the comment & suggestion lists)
//   • the Bun server (formatComment / insertComment for POST /api/comment)
// Keeping every read/write of the format in one module guarantees the human UI
// and the agent endpoint never diverge on grammar.
//
// IMPLEMENTATION OWNER: Piece 4. The signatures + JSDoc below are the contract
// the other pieces are written against — keep them stable.

import type { CritToken, CommentToken, CommentThread } from "./types";
import type { SuggestionToken } from "./types";

// Each construct is `{<open><inner><close>}`. We scan left-to-right, at every `{`
// try to match a construct by its opening delimiter and the FIRST occurrence of
// its matching closing delimiter after the inner text begins. Non-greedy by
// construction (we take the earliest valid close), so delimiter chars inside the
// body cannot over-match, and a dangling open with no close is simply skipped.

interface Delim {
  open: string; // text immediately after `{`
  close: string; // text immediately before `}`
}

// Order matters only for disambiguating overlapping open prefixes; the five
// CriticMarkup opens are mutually distinct, so any order works.
const DELIMS = {
  insert: { open: "++", close: "++" },
  delete: { open: "--", close: "--" },
  substitute: { open: "~~", close: "~~" },
  highlight: { open: "==", close: "==" },
  comment: { open: ">>", close: "<<" },
} satisfies Record<string, Delim>;

const SUBSTITUTE_ARROW = "~>";

// A construct must stay within one block (CriticMarkup is single-block) and must
// not contain another construct's opening delimiter. Both guards keep scanTokens
// in agreement with the editor's block-bounded lezer parser and prevent a stray /
// half-typed open from swallowing a later construct (and the prose between it).
const BLANK_LINE = /\n[ \t]*\n/;
const NESTED_OPEN = /\{(\+\+|--|~~|==|>>)/;

/**
 * Scan `text` and return every CriticMarkup token with absolute offsets, in
 * document order. Must tolerate:
 *   • all five constructs: {++ ++}, {-- --}, {~~ ~> ~~}, {== ==}, {>> <<}
 *   • adjacent / stacked comments at the same or overlapping anchor (e.g.
 *     `{==x==}{>>@a: ..<<}{>>@b: ..<<}`) — each is its own token; ids stay unique
 *   • `@author:` prefixes inside comments (author + body split out)
 *   • dangling / half-typed markup (`{++` with no close) → simply not matched
 *   • delimiter chars appearing in body text (non-greedy, bounded matching)
 * Tokens must NOT overlap each other in their [from,to) ranges (the markup
 * constructs are themselves non-overlapping in the linear text).
 */
export function scanTokens(text: string): CritToken[] {
  const tokens: CritToken[] = [];
  let index = 0; // running id counter, document order
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "{") {
      i += 1;
      continue;
    }

    const match = matchConstructAt(text, i);
    if (!match) {
      // Not the start of any complete construct (dangling open, or a lone `{`).
      i += 1;
      continue;
    }

    tokens.push(buildToken(String(index), match));
    index += 1;
    i = match.to; // continue strictly after this match — no overlap
  }

  return tokens;
}

type ConstructMatch = {
  type: CritToken["type"];
  from: number;
  to: number;
  raw: string;
  inner: string;
};

/**
 * Try to match a complete construct whose opening `{` is at `from`. Returns the
 * earliest valid close for the matched open delimiter, or null if `from` is not
 * the start of a complete construct.
 */
function matchConstructAt(text: string, from: number): ConstructMatch | null {
  for (const type of Object.keys(DELIMS) as (keyof typeof DELIMS)[]) {
    const { open, close } = DELIMS[type];
    const openAt = from + 1; // just past `{`
    if (!text.startsWith(open, openAt)) continue;

    const innerStart = openAt + open.length;
    const closeMarker = close + "}";
    // Earliest close at/after innerStart → non-greedy, body delimiters safe.
    const closeAt = text.indexOf(closeMarker, innerStart);
    if (closeAt === -1) continue; // dangling open: skip

    const inner = text.slice(innerStart, closeAt);

    // No-swallow / single-block guards: a stray or half-typed open must not consume
    // a later construct or cross a paragraph break. If the body crosses a blank line
    // or contains another construct's opening delimiter, treat THIS open as
    // unbalanced and bail — scanTokens then advances one char and matches the inner
    // construct at its real position (rather than deleting prose on accept/resolve).
    if (BLANK_LINE.test(inner)) continue;
    if (NESTED_OPEN.test(inner)) continue;
    // A substitution requires the ~> arrow (matches the editor's lezer parser, which
    // rejects an arrowless {~~ ~~}). Keeps the two parsers in agreement.
    if (type === "substitute" && !inner.includes(SUBSTITUTE_ARROW)) continue;

    const to = closeAt + closeMarker.length;
    return { type, from, to, raw: text.slice(from, to), inner };
  }
  return null;
}

function buildToken(id: string, m: ConstructMatch): CritToken {
  const base = { id, from: m.from, to: m.to, raw: m.raw };
  switch (m.type) {
    case "insert":
      return { ...base, type: "insert", inner: m.inner };
    case "delete":
      return { ...base, type: "delete", inner: m.inner };
    case "highlight":
      return { ...base, type: "highlight", inner: m.inner };
    case "substitute": {
      const arrowAt = m.inner.indexOf(SUBSTITUTE_ARROW);
      // No arrow → treat the whole inner as a no-op substitution (old == new).
      const oldText = arrowAt === -1 ? m.inner : m.inner.slice(0, arrowAt);
      const newText = arrowAt === -1 ? m.inner : m.inner.slice(arrowAt + SUBSTITUTE_ARROW.length);
      return { ...base, type: "substitute", oldText, newText };
    }
    case "comment": {
      const { author, body } = parseCommentInner(m.inner);
      return { ...base, type: "comment", author, body };
    }
  }
}

/**
 * Split a comment's inner text into `{ author, body }`. A leading `@name:` prefix
 * yields the trimmed name as author and the trimmed remainder as body; otherwise
 * author is null and body is the whole inner trimmed.
 *
 * We deliberately use the FIRST colon as the separator (rather than a strict
 * single-token handle) because real authors are multi-word names — the docx the
 * app seeds from has authors like "Daniel Steinbrook". The known edge case is a
 * comment that BEGINS with an @-mention sentence and later uses a colon as
 * punctuation (e.g. "@can you verify: ...") — it mis-attributes the lead-in as the
 * author. That input is rare and harmless (display-only); supporting multi-word
 * authors for the common `@author: body` form is the more important behaviour.
 */
function parseCommentInner(inner: string): { author: string | null; body: string } {
  const trimmed = inner.trimStart();
  if (trimmed.startsWith("@")) {
    const colonAt = trimmed.indexOf(":");
    if (colonAt !== -1) {
      const author = trimmed.slice(1, colonAt).trim();
      const body = restoreCloseMarker(trimmed.slice(colonAt + 1).trim());
      return { author, body };
    }
  }
  return { author: null, body: restoreCloseMarker(inner.trim()) };
}

/** Undo neutralizeCloseMarker so the displayed/derived body is byte-faithful. */
function restoreCloseMarker(text: string): string {
  return text.replaceAll("<<​}", "<<}");
}

/**
 * Format a comment into CriticMarkup. THE canonical grammar, shared by the
 * server endpoint and the in-UI "add comment" action so both write identically.
 *   formatComment("claude", "looks good") -> "{>>@claude: looks good<<}"
 *   formatComment("",       "looks good") -> "{>>looks good<<}"
 * Any `<<}` occurring inside `text` must be neutralised so it can't break the
 * marker.
 */
export function formatComment(author: string, text: string): string {
  const safe = neutralizeCloseMarker(text);
  const trimmedAuthor = author.trim();
  const body = trimmedAuthor ? `@${trimmedAuthor}: ${safe}` : safe;
  return `{>>${body}<<}`;
}

/** Break any literal close-marker sequence so body text can't terminate early. */
function neutralizeCloseMarker(text: string): string {
  // Insert a zero-width space between the `<<` and `}` of any `<<}` so the
  // closing-marker scan in scanTokens won't see it as a terminator. The visible
  // text is preserved; only the exact `<<}` byte sequence is interrupted.
  return text.replaceAll("<<}", "<<​}");
}

/**
 * Insert a formatted comment into `content` at character offset `anchorOffset`,
 * returning the new full content. Used by the server's POST /api/comment.
 * Inserts a single leading space if the preceding char is non-space, so the
 * marker doesn't fuse onto the anchored word.
 */
/**
 * Clamp an insert offset so it never lands INSIDE an existing comment's body —
 * which would create malformed nested `{>>…{>>…<<}…<<}` that can't parse and
 * renders raw (the comment-in-comment bug). If `at` is strictly inside a comment,
 * push it to just after that comment. Shared by the UI and server insert paths.
 */
export function clampAnchorOutsideComments(content: string, at: number): number {
  const enclosing = scanTokens(content).find(
    (t) => t.type === "comment" && at > t.from && at < t.to,
  );
  return enclosing ? enclosing.to : at;
}

export function insertComment(
  content: string,
  anchorOffset: number,
  text: string,
  author: string,
): string {
  const at = clampAnchorOutsideComments(content, Math.max(0, Math.min(anchorOffset, content.length)));
  const marker = formatComment(author, text);
  const prevChar = at > 0 ? content[at - 1] : "";
  const needsSpace = at > 0 && prevChar !== "" && !/\s/.test(prevChar);
  const insertion = needsSpace ? ` ${marker}` : marker;
  return content.slice(0, at) + insertion + content.slice(at);
}

/**
 * Given the RAW markup of a single suggestion and a mode, return the text that
 * should replace it (markup stripped). The caller dispatches a ranged edit over
 * the token's [from,to) with this string.
 *   applySuggestion("{++x++}",     "accept") -> "x"     // keep insertion
 *   applySuggestion("{++x++}",     "reject") -> ""      // drop insertion
 *   applySuggestion("{--x--}",     "accept") -> ""      // perform deletion
 *   applySuggestion("{--x--}",     "reject") -> "x"     // keep text
 *   applySuggestion("{~~a~>b~~}",  "accept") -> "b"     // take new
 *   applySuggestion("{~~a~>b~~}",  "reject") -> "a"     // keep old
 */
export function applySuggestion(raw: string, mode: "accept" | "reject"): string {
  const match = matchConstructAt(raw, 0);
  if (!match || match.to !== raw.length) {
    throw new Error(`applySuggestion: not a single complete construct: ${JSON.stringify(raw)}`);
  }

  switch (match.type) {
    case "insert":
      return mode === "accept" ? match.inner : "";
    case "delete":
      return mode === "accept" ? "" : match.inner;
    case "substitute": {
      const arrowAt = match.inner.indexOf(SUBSTITUTE_ARROW);
      const oldText = arrowAt === -1 ? match.inner : match.inner.slice(0, arrowAt);
      const newText =
        arrowAt === -1 ? match.inner : match.inner.slice(arrowAt + SUBSTITUTE_ARROW.length);
      return mode === "accept" ? newText : oldText;
    }
    default:
      throw new Error(`applySuggestion: not a suggestion construct: ${match.type}`);
  }
}

/**
 * Convenience for callers that hold a {@link SuggestionToken}. Equivalent to
 * `applySuggestion(token.raw, mode)`. Provided so the nav/editor needn't re-slice.
 */
export function applySuggestionToken(
  token: SuggestionToken,
  mode: "accept" | "reject",
): string {
  return applySuggestion(token.raw, mode);
}

// A thread-internal gap between two consecutive comments: only whitespace and
// highlight delimiters (`{==` / `==}`). Comments on the SAME anchor span are
// stacked as nested highlights (Google Docs' .docx export), so siblings are
// separated by the orphaned highlight closes — e.g. `{>>c0<<}==}{>>c1<<}` (gap
// `==}`) — or directly adjacent (`{>>a<<}{>>b<<}`, gap ``). Real prose between two
// comments means different anchors → different threads.
const THREAD_GAP = /^(?:\s*(?:\{==|==\})\s*)*$/;

/**
 * Group comments into threads by shared anchor span. Comments separated only by
 * THREAD_GAP noise (nothing but whitespace + highlight delimiters) are stacked on
 * the same/overlapping span and form one thread, parent first then replies — the
 * way a Google Docs comment thread renders. `text` is the full document, used to
 * test the inter-comment gap. Input order is document order.
 */
/**
 * Approximate "accepted prose" word count of a CriticMarkup document, for a live
 * header readout. Regex-based (nesting-safe, unlike the bailing token scanner):
 * drop comments and deletions, take the NEW side of substitutions, keep inserted
 * and highlighted text, then strip the common Markdown syntax markers so `#`, `**`
 * etc. don't count as words. A rough count by design — not a billing figure.
 */
export function countWords(text: string): number {
  let s = text;
  // ── CriticMarkup → accepted prose ──
  s = s.replace(/\{>>[\s\S]*?<<\}/g, " "); // comments: not prose
  s = s.replace(/\{--[\s\S]*?--\}/g, " "); // deletions: removed
  s = s.replace(/\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g, "$2"); // substitution → new side
  s = s.replace(/\{\+\+([\s\S]*?)\+\+\}/g, "$1"); // insertion → kept
  s = s.replace(/\{==|==\}/g, ""); // highlight delimiters (handles nesting)
  // ── Markdown markers (so they aren't counted as words) ──
  s = s.replace(/`([^`]*)`/g, "$1"); // inline code → content
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // [text](url) → text
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // heading markers
  s = s.replace(/^\s*>\s?/gm, ""); // blockquote markers
  s = s.replace(/^\s*[-*+]\s+/gm, ""); // list bullets
  s = s.replace(/\*\*|\*|__|_/g, ""); // emphasis markers
  const words = s.match(/\S+/g);
  return words ? words.length : 0;
}

/**
 * The edit that RESOLVES an anchored comment run `[runFrom, runTo)`. If the comments
 * are anchored to a highlight — `{==span==}{>>..<<}`, including the stacked nested
 * form `{=={==span==}{>>c0<<}==}{>>c1<<}` — strip the WHOLE anchor (the outer `{==`
 * opens, the highlight delimiters, and every comment marker), leaving just the span
 * prose. Without this, resolving left an orphaned `{==…==}` highlight (and a leaked
 * outer `{==`) behind. A point comment with no highlight just has its run removed.
 */
export function resolveAnchorEdit(
  content: string,
  runFrom: number,
  runTo: number,
): { from: number; to: number; insert: string } {
  // The anchor highlight is the (innermost) highlight whose close abuts the run.
  const hl = scanTokens(content).find((t) => t.type === "highlight" && t.to === runFrom);
  if (!hl || hl.type !== "highlight") {
    return { from: runFrom, to: runTo, insert: "" }; // point comment — just drop it
  }
  // Swallow any outer `{==` opens stacked immediately before the inner highlight.
  let start = hl.from;
  while (start >= 3 && content.slice(start - 3, start) === "{==") start -= 3;
  return { from: start, to: runTo, insert: hl.inner };
}

// ── Auto-heal: flatten comments accidentally nested inside other comments ──────
// A comment dropped INSIDE another comment's body — `{>>A{>>B<<}C<<}` — is malformed
// (the outer can't parse, renders raw, and splits a word). Healing rebuilds it as
// adjacent comments — `{>>AC<<}{>>B<<}` — rejoining the outer's split body and
// pulling the inner out as its own (adjacent → it threads). Recurses for deeper nests.

interface CommentScan {
  end: number; // index just past the balanced closing `<<}`
  nested: boolean; // an inner `{>>` appeared before the balanced close
  outerBody: string; // the outer comment's own text (inner comments removed)
  inner: string[]; // the nested comment substrings (still raw, possibly nested)
}

/** Scan a balanced comment starting at `{>>` index `i`. null if unbalanced. */
function scanComment(content: string, i: number): CommentScan | null {
  let depth = 1;
  let j = i + 3;
  let outerBody = "";
  const inner: string[] = [];
  let innerStart = -1;
  let nested = false;
  while (j < content.length) {
    if (content.startsWith("{>>", j)) {
      if (depth === 1) {
        innerStart = j;
        nested = true;
      }
      depth += 1;
      j += 3;
    } else if (content.startsWith("<<}", j)) {
      depth -= 1;
      if (depth === 1 && innerStart >= 0) {
        inner.push(content.slice(innerStart, j + 3));
        innerStart = -1;
      }
      if (depth === 0) return { end: j + 3, nested, outerBody, inner };
      j += 3;
    } else {
      if (depth === 1) outerBody += content[j];
      j += 1;
    }
  }
  return null; // no balanced close — leave it alone
}

/** Document offset of the first malformed (nested) comment, for "jump to it". */
export function firstNestedCommentStart(content: string): number | null {
  for (let i = content.indexOf("{>>"); i >= 0; i = content.indexOf("{>>", i + 3)) {
    const s = scanComment(content, i);
    if (s?.nested) return i;
    if (s) i = s.end - 3; // skip past a clean comment
  }
  return null;
}

/** Whether the document has any comment nested inside another (auto-healable). */
export function hasNestedComments(content: string): boolean {
  return firstNestedCommentStart(content) !== null;
}

/**
 * Count of malformed comment openers: every `{>>` that scanTokens did NOT resolve
 * into a comment token — i.e. nested-in-another, broken/missing `<<}` close, or
 * dangling. Drives the warning marker (broader than just nesting).
 */
export function unparsedCommentCount(content: string): number {
  const raw = (content.match(/\{>>/g) ?? []).length;
  const parsed = scanTokens(content).filter((t) => t.type === "comment").length;
  return Math.max(0, raw - parsed);
}

/** Offset of the first `{>>` that didn't parse into a comment token (jump target). */
export function firstUnparsedCommentStart(content: string): number | null {
  const parsedStarts = new Set(
    scanTokens(content)
      .filter((t) => t.type === "comment")
      .map((t) => t.from),
  );
  for (let i = content.indexOf("{>>"); i >= 0; i = content.indexOf("{>>", i + 3)) {
    if (!parsedStarts.has(i)) return i;
  }
  return null;
}

/** List each malformed (nested) comment: its offset + a short preview of the text
 *  that wraps the nested one — for a "problems"-style list with jump + heal. */
export function nestedCommentIssues(content: string): { from: number; preview: string }[] {
  const out: { from: number; preview: string }[] = [];
  for (let i = content.indexOf("{>>"); i >= 0; i = content.indexOf("{>>", i + 3)) {
    const s = scanComment(content, i);
    if (s?.nested) {
      const { author, body } = parseCommentInner(s.outerBody);
      const text = (author ? `@${author}: ` : "") + body;
      out.push({ from: i, preview: text.replace(/\s+/g, " ").trim().slice(0, 64) });
    }
    if (s) i = s.end - 3;
  }
  return out;
}

/** Flatten every nested comment into adjacent comments. Idempotent + recursive. */
export function healNestedComments(content: string): string {
  let out = content;
  for (let guard = 0; guard < 5000; guard++) {
    let changed = false;
    for (let i = out.indexOf("{>>"); i >= 0; i = out.indexOf("{>>", i + 3)) {
      const s = scanComment(out, i);
      if (!s) {
        continue;
      }
      if (s.nested) {
        // Pull each nested comment OUT as a space-separated standalone comment — NOT
        // adjacent (which would thread it with the host). A comment-in-comment is a
        // mistaken insertion, not a reply, so the recovered one becomes its own card.
        const healed = `{>>${s.outerBody}<<}` + s.inner.map((c) => " " + c).join("");
        out = out.slice(0, i) + healed + out.slice(s.end);
        changed = true;
        break; // re-scan from scratch (offsets shifted; inner may still nest)
      }
      i = s.end - 3;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * Heal just ONE nested comment — the one whose `{>>` starts at `from`. Returns the
 * new full content, or null if there's nothing nested to heal there. Pulls each
 * directly-nested comment out as a space-separated standalone comment (same rule as
 * healNestedComments) but touches ONLY this one — so the per-issue review can step
 * through and apply fixes individually. A still-nested inner surfaces as its own
 * issue on the next pass.
 */
export function healOneNestedComment(content: string, from: number): string | null {
  if (!content.startsWith("{>>", from)) return null;
  const s = scanComment(content, from);
  if (!s || !s.nested) return null;
  const healed = `{>>${s.outerBody}<<}` + s.inner.map((c) => " " + c).join("");
  return content.slice(0, from) + healed + content.slice(s.end);
}

export interface NestedCommentDetail {
  outerAuthor: string | null;
  outerPreview: string; // the host comment's own (rejoined) text
  inners: { author: string | null; preview: string }[]; // comments to pull out
  splitWord: { before: string; after: string } | null; // word the inner splits, e.g. differen|t
}

/** Everything the per-issue heal review needs to show what a heal WILL do at `from`:
 *  the host comment, the comment(s) wrongly pasted inside it, and the word that the
 *  first inner splits (so we can render "differen|t → different"). null if nothing
 *  nested is there. Pure — the UI stays presentational. */
export function nestedCommentDetail(content: string, from: number): NestedCommentDetail | null {
  if (!content.startsWith("{>>", from)) return null;
  const s = scanComment(content, from);
  if (!s || !s.nested) return null;
  const clean = (t: string) => t.replace(/\s+/g, " ").trim();
  const outer = parseCommentInner(s.outerBody);
  const inners = s.inner.map((raw) => {
    const sc = scanComment(raw, 0);
    const p = parseCommentInner(sc ? sc.outerBody : raw.replace(/^\{>>|<<\}$/g, ""));
    return { author: p.author, preview: clean(p.body).slice(0, 90) };
  });
  let splitWord: { before: string; after: string } | null = null;
  const raw = content.slice(from, s.end);
  const innerIdx = s.inner[0] ? raw.indexOf(s.inner[0]) : -1;
  if (innerIdx >= 0) {
    const before = raw.slice(0, innerIdx).match(/(\S*)$/)?.[1] ?? "";
    const after = raw.slice(innerIdx + s.inner[0].length).match(/^(\S*)/)?.[1] ?? "";
    if (before || after) splitWord = { before, after };
  }
  return { outerAuthor: outer.author, outerPreview: clean(outer.body).slice(0, 130), inners, splitWord };
}

export function groupThreads(comments: CommentToken[], text: string): CommentThread[] {
  const sorted = [...comments].sort((a, b) => a.from - b.from);
  const threads: CommentThread[] = [];
  for (const c of sorted) {
    const last = threads[threads.length - 1];
    const gap = last ? text.slice(last.to, c.from) : null;
    if (last && THREAD_GAP.test(gap as string)) {
      last.comments.push(c);
      last.to = c.to;
    } else {
      threads.push({ id: c.id, from: c.from, to: c.to, comments: [c] });
    }
  }
  return threads;
}
