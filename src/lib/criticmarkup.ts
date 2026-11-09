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

import type { CritToken, CommentToken, CommentThread, SidebarCard } from "./types";
import type { SuggestionToken } from "./types";
import { markdownLiteralRanges, positionInRanges } from "./markdownLiteralRanges";
import type { SourceRange } from "./markdownLiteralRanges";

// Re-export the public token types so agents/scripts can get everything from this
// one module (the documented entry point in skills/acm-review/SKILL.md), not types.
export type { CritToken, CommentToken, CommentThread, SuggestionToken, SidebarCard } from "./types";

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

// Constructs normally stay within one block and must not contain another
// construct's opening delimiter. The deliberate exceptions are nesting-aware
// highlights and whole-line insertion blocks, which may carry Markdown blocks.
// These guards prevent a stray/half-typed open from swallowing later prose.
const BLANK_LINE = /\r?\n[ \t]*\r?\n/;
const NESTED_OPEN = /\{(\+\+|--|~~|==|>>)/;

function standaloneInsertionRange(content: string, from: number, to: number): boolean {
  if (from < 0 || to < from || to > content.length) return false;

  const lineStart = content.lastIndexOf("\n", from - 1) + 1;
  const lineEnd = content.indexOf("\n", to);
  const after = lineEnd === -1 ? content.length : lineEnd;

  return (
    /^[ \t\r]*$/.test(content.slice(lineStart, from)) &&
    /^[ \t\r]*$/.test(content.slice(to, after))
  );
}

// One line of plain added prose or one plain list item reads as an inline green
// insertion (#79). A block form (heading, quote, table, fence, HTML, rule,
// indented code) or inline Markdown (code, emphasis, links, maths, escapes)
// needs the rich block preview, which renders it.
const BLOCK_LINE = /^(?:[ \t]*(?:#{1,6}[ \t]|>|\||```|~~~|<)|(?: {4}|\t)|[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$)/;
const INLINE_MARKDOWN = /[`*_[\]<$\\~]/;

/** True when an insertion occupies a whole Markdown line/block in `content`
 * AND needs the rendered block preview: it spans several lines, or its one line
 * is a block construct. The token may contain newlines and blank lines; only the
 * surrounding line prefixes/suffixes must be indentation whitespace. */
export function isStandaloneInsertion(
  content: string,
  token: Pick<CritToken, "type" | "from" | "to">,
): boolean {
  if (token.type !== "insert") return false;
  const raw = content.slice(token.from, token.to);
  if (!raw.startsWith("{++") || !raw.endsWith("++}")) return false;
  const inner = raw.slice(3, -3);
  const oneLine = !inner.includes("\n");
  // A bullet's own marker (`* item`) is not formatting.
  const text = inner.replace(/^[ \t]*[-*+][ \t]+/, "");
  if (oneLine && !BLOCK_LINE.test(inner) && !INLINE_MARKDOWN.test(text)) return false;
  return standaloneInsertionRange(content, token.from, token.to);
}

/**
 * Scan `text` and return every CriticMarkup token with absolute offsets, in
 * document order. Must tolerate:
 *   • all five constructs: {++ ++}, {-- --}, {~~ ~> ~~}, {== ==}, {>> <<}
 *   • adjacent / stacked comments at the same or overlapping anchor (e.g.
 *     `{==x==}{>>@a: ..<<}{>>@b: ..<<}`) — each is its own token; ids stay unique
 *   • `@author:` prefixes inside comments (author + body split out)
 *   • whole-line insertion blocks containing headings, lists, and blank lines
 *   • dangling / half-typed markup (`{++` with no close) → simply not matched
 *   • delimiter chars appearing in body text (non-greedy, bounded matching)
 * Tokens do not overlap, with ONE deliberate exception: a highlight anchor may
 * WRAP tracked changes (`{==a {++b++} c==}` — the GDocs converter and agent
 * suggestions both produce this), and then the nested insert/delete/substitute
 * tokens are ALSO emitted, contained inside the highlight's [from,to). Consumers
 * that walk suggestions or comments see exactly the tokens they always did; the
 * containing highlight is additive (it's what anchors a SUGGEST to the span).
 */
export function scanTokens(text: string): CritToken[] {
  const tokens: CritToken[] = [];
  // CONTENT-DERIVED ids (#19): hash of the raw markup, plus an occurrence index
  // for byte-identical duplicates. Positional ids made every card below an
  // added/removed construct remount (id reindex); content ids survive unrelated
  // edits, so card identity — and the active selection — stays put.
  const occurrences = new Map<string, number>();
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

    const n = occurrences.get(match.raw) ?? 0;
    occurrences.set(match.raw, n + 1);
    tokens.push(buildToken(n === 0 ? hashId(match.raw) : `${hashId(match.raw)}.${n}`, match));
    // A highlight wrapping tracked changes: re-enter its inner so the nested
    // {++/--/~~} constructs get their own (contained) tokens too. Everything
    // else continues strictly after the match — no overlap.
    i = match.type === "highlight" && NESTED_OPEN.test(match.inner) ? match.from + 3 : match.to;
  }

  return tokens;
}

/** djb2 over the raw construct text, base36 — short, stable, non-cryptographic
 *  (collisions are disambiguated by the occurrence index only for IDENTICAL raws;
 *  cross-raw hash collisions are vanishingly unlikely at document scale). */
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
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

    // Highlights are nesting-aware (they anchor comments and may wrap tracked
    // changes) — they get their own matcher that mirrors the lezer grammar.
    if (type === "highlight") return matchHighlightAt(text, from);

    const innerStart = openAt + open.length;
    const closeMarker = close + "}";
    // Earliest close at/after innerStart → non-greedy, body delimiters safe.
    const closeAt = text.indexOf(closeMarker, innerStart);
    if (closeAt === -1) continue; // dangling open: skip

    const inner = text.slice(innerStart, closeAt);
    const candidateTo = closeAt + closeMarker.length;

    // No-swallow / single-block guards: a stray or half-typed open must not consume
    // a later construct or cross a paragraph break. If the body crosses a blank line
    // or contains another construct's opening delimiter, treat THIS open as
    // unbalanced and bail — scanTokens then advances one char and matches the inner
    // construct at its real position (rather than deleting prose on accept/resolve).
    if (
      BLANK_LINE.test(inner) &&
      !(type === "insert" && standaloneInsertionRange(text, from, candidateTo))
    ) {
      continue;
    }
    if (NESTED_OPEN.test(inner)) continue;
    // A substitution requires the ~> arrow (matches the editor's lezer parser, which
    // rejects an arrowless {~~ ~~}). Keeps the two parsers in agreement.
    if (type === "substitute" && !inner.includes(SUBSTITUTE_ARROW)) continue;

    return { type, from, to: candidateTo, raw: text.slice(from, candidateTo), inner };
  }
  return null;
}

/**
 * Highlight-specific matcher: NESTING-AWARE, mirroring the editor's lezer grammar
 * (where `{==`/`==}` are paired delimiters, so an anchor may WRAP tracked changes:
 * `{==span with {++ins++} and {--del--} bits==}`). The generic NESTED_OPEN guard
 * would drop such an anchor entirely — the editor would render a highlight the lib
 * can't see, leaving any `SUGGEST:` comment on it dead (no inline render, no Apply).
 * Rules:
 *   • a COMPLETE nested insert/delete/substitution is opaque — skipped whole, so a
 *     `==}` inside its body can't close the highlight early;
 *   • a nested `{==` or `{>>` bails (unparsed), preserving the FLAT stacked-thread
 *     model where outer wrappers are gap noise and inner comments stay tokens;
 *   • a half-typed nested open is literal text (same as lezer, whose failed inline
 *     parse simply doesn't consume);
 *   • single-block: a blank line before the close → no match.
 */
function matchHighlightAt(text: string, from: number): ConstructMatch | null {
  const innerStart = from + 3; // past `{==`
  for (let i = innerStart; i < text.length; ) {
    const ch = text[i];
    if (ch === "=" && text.startsWith("==}", i)) {
      const to = i + 3;
      return {
        type: "highlight",
        from,
        to,
        raw: text.slice(from, to),
        inner: text.slice(innerStart, i),
      };
    }
    if (ch === "\n") {
      let j = i + 1;
      // `\r` too, so a CRLF blank line counts like an LF one (#96).
      while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\r")) j += 1;
      if (j < text.length && text[j] === "\n") return null; // crossed a blank line
      i = j;
      continue;
    }
    if (ch === "{") {
      if (text.startsWith("{==", i) || text.startsWith("{>>", i)) return null;
      const nested = matchConstructAt(text, i);
      if (nested) {
        i = nested.to;
        continue;
      }
    }
    i += 1;
  }
  return null; // dangling open
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
const COMMENT_CODEC_PREFIX = "~acm1~";
const COMMENT_AUTHOR_CODEC_PREFIX = "~acma1~";

function serializeCommentAuthor(author: string): string {
  const trimmed = author.trim();
  if (!trimmed) return "";
  if (
    !trimmed.startsWith(COMMENT_AUTHOR_CODEC_PREFIX) &&
    !/[:{}\r\n\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return trimmed;
  }
  return COMMENT_AUTHOR_CODEC_PREFIX + encodeURIComponent(trimmed);
}

function decodeCommentAuthor(author: string): string {
  if (!author.startsWith(COMMENT_AUTHOR_CODEC_PREFIX)) return author;
  try {
    const decoded = decodeURIComponent(author.slice(COMMENT_AUTHOR_CODEC_PREFIX.length));
    return serializeCommentAuthor(decoded) === author ? decoded : author;
  } catch {
    return author;
  }
}

/** Decode the one-line storage form used for comment bodies that cannot safely
 * live literally inside CriticMarkup. Unknown escapes stay byte-faithful so a
 * future codec extension cannot silently discard existing content. */
function decodeCommentBody(text: string): string | null {
  if (!text.startsWith(COMMENT_CODEC_PREFIX)) return null;

  let decoded = "";
  for (let i = COMMENT_CODEC_PREFIX.length; i < text.length; i++) {
    if (text[i] !== "\\") {
      decoded += text[i];
      continue;
    }
    if (text.startsWith("\\u007b", i)) {
      decoded += "{";
      i += 5;
    } else if (text.startsWith("\\u007d", i)) {
      decoded += "}";
      i += 5;
    } else if (text.startsWith("\\u007c", i)) {
      decoded += "|";
      i += 5;
    } else if (text[i + 1] === "n") {
      decoded += "\n";
      i += 1;
    } else if (text[i + 1] === "r") {
      decoded += "\r";
      i += 1;
    } else if (text[i + 1] === "\\") {
      decoded += "\\";
      i += 1;
    } else {
      decoded += "\\";
    }
  }
  // A literal legacy body may coincidentally start with the prefix. Only accept
  // the payload when decoding and re-encoding reproduces the exact stored form.
  return serializeCommentBody(decoded) === text ? decoded : null;
}

function parseCommentInner(inner: string): { author: string | null; body: string } {
  const trimmed = inner.trimStart();
  if (trimmed.startsWith("@")) {
    const colonAt = trimmed.indexOf(":");
    if (colonAt !== -1) {
      const author = decodeCommentAuthor(trimmed.slice(1, colonAt).trim());
      const remainder = trimmed.slice(colonAt + 1);
      const stored = remainder.startsWith(" ") ? remainder.slice(1) : remainder;
      const body = decodeCommentBody(stored) ?? restoreCloseMarker(remainder.trim());
      return { author, body };
    }
  }
  return {
    author: null,
    body: decodeCommentBody(inner) ?? restoreCloseMarker(inner.trim()),
  };
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
 * Bodies that could cross a Markdown paragraph or resemble delimiters use the
 * canonical one-line codec; ordinary comments retain their historical bytes.
 */
export function formatComment(author: string, text: string): string {
  const safe = serializeCommentBody(text);
  const safeAuthor = serializeCommentAuthor(author);
  const body = safeAuthor ? `@${safeAuthor}: ${safe}` : safe;
  return `{>>${body}<<}`;
}

export type ReviewItemEdit =
  | { ok: true; change: { from: number; to: number; insert: string } }
  | {
      ok: false;
      reason: "empty" | "unsupported" | "invalid-markup" | "not-wrappable";
    };

/** Replace one comment's body without changing its self-declared Author. */
export function commentBodyEdit(
  comment: CommentToken,
  body: string,
): ReviewItemEdit {
  if (!body.trim()) return { ok: false, reason: "empty" };
  return {
    ok: true,
    change: {
      from: comment.from,
      to: comment.to,
      insert: formatComment(comment.author ?? "", body),
    },
  };
}

function validInlineSuggestionText(text: string, close: "++}" | "~~}"): boolean {
  return (
    !text.includes(close) &&
    !BLANK_LINE.test(text) &&
    !NESTED_OPEN.test(text)
  );
}

/**
 * Edit only the proposed wording of a Suggestion.
 *
 * SUGGEST cards keep their Author and optional group id. Native insertions and
 * substitutions keep their existing CriticMarkup shape; native deletions have no
 * proposed wording to edit and therefore remain unsupported.
 */
export function suggestionProposalEdit(
  suggestion: CommentToken | SuggestionToken,
  proposal: string,
): ReviewItemEdit {
  if (suggestion.type === "comment") {
    if (suggestionReplacement(suggestion.body) === null) {
      return { ok: false, reason: "unsupported" };
    }
    const groupId = suggestionGroupId(suggestion.body);
    const prefix = groupId ? `SUGGEST[g:${groupId}]: ` : "SUGGEST: ";
    return {
      ok: true,
      change: {
        from: suggestion.from,
        to: suggestion.to,
        insert: formatComment(suggestion.author ?? "", prefix + proposal),
      },
    };
  }

  if (suggestion.type === "delete") {
    return { ok: false, reason: "unsupported" };
  }
  const close = suggestion.type === "insert" ? "++}" : "~~}";
  if (!validInlineSuggestionText(proposal, close)) {
    return { ok: false, reason: "invalid-markup" };
  }
  return {
    ok: true,
    change: {
      from: suggestion.from,
      to: suggestion.to,
      insert:
        suggestion.type === "insert"
          ? `{++${proposal}++}`
          : `{~~${suggestion.oldText}~>${proposal}~~}`,
    },
  };
}

export type SelectionAnnotationKind = "comment" | "suggestion";

/** Build one span-anchored comment or SUGGEST card without mutating source. */
export function selectionAnnotationEdit(
  content: string,
  from: number,
  to: number,
  author: string,
  text: string,
  kind: SelectionAnnotationKind,
): ReviewItemEdit {
  if (!text.trim()) return { ok: false, reason: "empty" };
  if (!wrappableSpan(content, from, to)) {
    return { ok: false, reason: "not-wrappable" };
  }
  const span = content.slice(from, to);
  const body = kind === "suggestion" ? `SUGGEST: ${text}` : text;
  return {
    ok: true,
    change: {
      from,
      to,
      insert: `{==${span}==}${formatComment(author, body)}`,
    },
  };
}

/** Canonicalise one complete raw comment marker supplied by an agent batch.
 * Non-comment inserts stay byte-identical. The body is decoded without trimming
 * so literal line breaks and boundary whitespace are never silently discarded. */
export function canonicalizeCommentMarker(marker: string): string {
  if (!marker.startsWith("{>>") || !marker.endsWith("<<}")) return marker;
  const inner = marker.slice(3, -3);
  const trimmed = inner.trimStart();
  if (trimmed.startsWith("@")) {
    const colonAt = trimmed.indexOf(":");
    if (colonAt !== -1) {
      const author = decodeCommentAuthor(trimmed.slice(1, colonAt).trim());
      const remainder = trimmed.slice(colonAt + 1);
      const stored = remainder.startsWith(" ") ? remainder.slice(1) : remainder;
      return formatComment(author, decodeCommentBody(stored) ?? restoreCloseMarker(stored));
    }
  }
  return formatComment("", decodeCommentBody(inner) ?? restoreCloseMarker(inner));
}

/** Store risky comment bodies on one physical line so Markdown paragraph breaks,
 * nested-looking delimiters, and boundary whitespace survive exactly. Simple
 * one-line comments retain their historical byte representation. */
function serializeCommentBody(text: string): string {
  const needsCodec =
    text.startsWith(COMMENT_CODEC_PREFIX) ||
    text.trimStart() !== text ||
    text.trimEnd() !== text ||
    /[\\\r\n{}|]/.test(text);
  if (!needsCodec) return neutralizeCloseMarker(text);

  let encoded = COMMENT_CODEC_PREFIX;
  for (const char of text) {
    if (char === "\\") encoded += "\\\\";
    else if (char === "\r") encoded += "\\r";
    else if (char === "\n") encoded += "\\n";
    else if (char === "{") encoded += "\\u007b";
    else if (char === "}") encoded += "\\u007d";
    else if (char === "|") encoded += "\\u007c";
    else encoded += char;
  }
  return encoded;
}

/** Break any literal close-marker sequence so body text can't terminate early. */
function neutralizeCloseMarker(text: string): string {
  // Insert a zero-width space between the `<<` and `}` of any `<<}` so the
  // closing-marker scan in scanTokens won't see it as a terminator. The visible
  // text is preserved; only the exact `<<}` byte sequence is interrupted.
  return text.replaceAll("<<}", "<<​}");
}

// ── Structural heals: repair converter-era leaks IN PLACE ──────────────────────
// Two mechanical repairs for markup that renders raw (both produced by the old
// docx converter; the fixed converter no longer emits them, but existing docs
// carry them):
//   • a highlight whose `==}` lies past a blank line (multi-block anchor) — the
//     open moves to the start of the close's block, so the anchor becomes a legal
//     single-block span on the text nearest the comment; earlier paragraphs stay
//     as plain prose. Stacked `{=={==` forms converge to the canonical stacked-
//     thread shape over iterations.
//   • complete comments trapped inside a tracked change (`{++{>>c<<}x++}`) — the
//     comments move to just AFTER the wrapper, where adjacency threads them onto
//     it; the wrapper then parses.

/** Position OF the matching `==}` for the `{==` at `openPos` (not past it),
 *  scanning nesting-aware and treating complete constructs as opaque (a `==}`
 *  inside a comment body can't match). -1 when the highlight never closes. */
function findHighlightClose(text: string, openPos: number, literals?: SourceRange[]): number {
  let depth = 1;
  let i = openPos + 3;
  while (i < text.length) {
    const lit = literals?.find((r) => r.from <= i && i < r.to);
    if (lit) {
      i = lit.to; // a delimiter inside code is text
      continue;
    }
    if (text.startsWith("==}", i)) {
      depth -= 1;
      if (depth === 0) return i;
      i += 3;
      continue;
    }
    if (text.startsWith("{==", i)) {
      depth += 1;
      i += 3;
      continue;
    }
    if (text.startsWith("{>>", i)) {
      const s = scanComment(text, i);
      i = s ? s.end : i + 3;
      continue;
    }
    if (text[i] === "{") {
      const m = matchConstructAt(text, i);
      if (m && m.type !== "highlight") {
        i = m.to;
        continue;
      }
    }
    i += 1;
  }
  return -1;
}

// Markdown line prefix at a block start (blockquote markers, list bullet, heading)
// — a relocated `{==` must land AFTER it so the block still parses as markdown.
const BLOCK_LINE_PREFIX = /^(?:\s*>\s?)*(?:\s*(?:[-*+]|\d{1,3}[.)])\s+)?(?:#{1,6}\s+)?/;

/** ONE balanced legacy comment whose literal blank line made it invalid Markdown,
 * rewritten through the canonical one-line codec. Ambiguous nested comments and
 * truly dangling markers remain untouched for the validator to report. */
function healOneMultilineComment(content: string): string | null {
  for (let i = content.indexOf("{>>"); i >= 0; i = content.indexOf("{>>", i + 3)) {
    if (inLiteral(content, i)) continue; // an example in code stays byte-identical (#97)
    const scanned = scanComment(content, i);
    if (!scanned || scanned.nested || matchConstructAt(content, i)) continue;

    const inner = content.slice(i + 3, scanned.end - 3);
    if (!BLANK_LINE.test(inner)) continue;

    const trimmed = inner.trimStart();
    let author = "";
    let body = inner;
    if (trimmed.startsWith("@")) {
      const colonAt = trimmed.indexOf(":");
      if (colonAt !== -1) {
        author = decodeCommentAuthor(trimmed.slice(1, colonAt).trim());
        const remainder = trimmed.slice(colonAt + 1);
        body = remainder.startsWith(" ") ? remainder.slice(1) : remainder;
      }
    }

    const healed = formatComment(author, restoreCloseMarker(body));
    return content.slice(0, i) + healed + content.slice(scanned.end);
  }
  return null;
}

/** ONE multi-block-anchor repair, or null when none is needed. */
function healOneMultiBlockAnchor(content: string): string | null {
  for (let i = content.indexOf("{=="); i >= 0; i = content.indexOf("{==", i + 3)) {
    if (inLiteral(content, i)) continue; // an example in code stays byte-identical (#97)
    const close = findHighlightClose(content, i);
    if (close < 0) continue; // truly dangling — not mechanically healable
    const inner = content.slice(i + 3, close);
    if (!BLANK_LINE.test(inner)) continue; // single-block — fine (non-global regex, stateless)
    // Start of the close's block: just past the LAST blank line before the close…
    let blockStart = i + 3;
    const re = /\r?\n[ \t]*\r?\n/g; // BLANK_LINE, CRLF included (#96)
    for (let m = re.exec(inner); m; m = re.exec(inner)) blockStart = i + 3 + m.index + m[0].length;
    // …skipping the markdown line prefix so `> `/`- `/`#` keep their meaning.
    const prefix = BLOCK_LINE_PREFIX.exec(content.slice(blockStart, close))?.[0] ?? "";
    const insertAt = blockStart + prefix.length;
    // Remove the open at i, re-insert at the block (offsets shift left by 3).
    const without = content.slice(0, i) + content.slice(i + 3);
    return without.slice(0, insertAt - 3) + "{==" + without.slice(insertAt - 3);
  }
  return null;
}

/** ONE comment-inside-wrapper repair, or null when none is needed. */
function healOneCommentInWrapper(content: string): string | null {
  for (const open of ["{++", "{--"]) {
    const close = open === "{++" ? "++}" : "--}";
    for (let i = content.indexOf(open); i >= 0; i = content.indexOf(open, i + 3)) {
      if (inLiteral(content, i)) continue; // an example in code stays byte-identical (#97)
      if (matchConstructAt(content, i)) continue; // parses — nothing to heal
      const closeAt = content.indexOf(close, i + 3);
      if (closeAt < 0 || closeAt >= paragraphEnd(content, i)) continue;
      const inner = content.slice(i + 3, closeAt);
      const comments = scanTokens(inner).filter((t): t is CommentToken => t.type === "comment");
      if (comments.length === 0) continue;
      // Pull the comments out; the wrapper is healable only if what remains is
      // construct-free (a residual {== etc. would still break it).
      let residue = "";
      let cursor = 0;
      for (const c of comments) {
        residue += inner.slice(cursor, c.from);
        cursor = c.to;
      }
      residue += inner.slice(cursor);
      // The residue must carry NO other markup — a leftover open would still break
      // the wrapper, and a leftover close (`==}` etc.) would, once the wrapper
      // parses, be swallowed INTO it and change how surrounding markup resolves
      // (seen in the wild: `{==a {++==}{>>c<<}b++}` — healing the insert dangled
      // the outer highlight). Cross-construct interleaves stay flagged, unhealed.
      if (NESTED_OPEN.test(residue) || /==\}|<<\}|\+\+\}|--\}|~~\}/.test(residue)) continue;
      const moved = comments.map((c) => c.raw).join("");
      return (
        content.slice(0, i) + open + residue + close + moved + content.slice(closeAt + 3)
      );
    }
  }
  return null;
}

/** An anchor `{==…==}` whose span contains complete comments — an editor reply
 *  typed inside the anchor (#72) or an anchor wrapped around another thread (#65).
 *  Its own thread can't resolve the span, so a SUGGEST on it is dead. */
interface CommentInAnchor {
  open: number; // the outer `{==`
  close: number; // position OF its matching `==}`
  threadEnd: number; // end of the comment run that follows the close
  prose: string; // the span's words, comments and inner anchor delimiters removed
  lifted: string[]; // the comments found inside the span, in order (raw)
  trailing: string; // the separator dropped before a comment that ended the span
  // False when a lifted comment is itself a SUGGEST: moving it onto the outer
  // thread would retarget it to the whole span, so a human must move it.
  healable: boolean;
}

/** The comments directly inside `inner` (nested ones stay inside their host),
 *  skipping comment-shaped examples inside Markdown literals. `offset` maps
 *  `inner` back to document positions. */
function topLevelComments(inner: string, offset: number, literals: SourceRange[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let i = inner.indexOf("{>>"); i >= 0; i = inner.indexOf("{>>", i)) {
    if (positionInRanges(offset + i, literals)) {
      i += 3;
      continue;
    }
    const s = scanComment(inner, i);
    if (!s) {
      i += 3;
      continue;
    }
    out.push({ from: i, to: s.end });
    i = s.end;
  }
  return out;
}

/** The comment-in-anchor defect opened at `open`, or null. The legitimate stacked
 *  thread (`{=={==span==}{>>c0<<}==}{>>c1<<}`: inner anchors + comments, no prose
 *  after them) is NOT a defect. */
function commentInAnchorAt(content: string, open: number): CommentInAnchor | null {
  if (!content.startsWith("{==", open) || matchHighlightAt(content, open)) return null;
  const close = findHighlightClose(content, open);
  if (close < 0 || close >= paragraphEnd(content, open)) return null;
  const literals = cachedLiteralRanges(content);
  const base = open + 3;
  const inner = content.slice(base, close);
  const comments = topLevelComments(inner, base, literals);
  if (comments.length === 0) return null;

  let stripped = "";
  let cursor = 0;
  for (const c of comments) {
    stripped += inner.slice(cursor, c.from);
    cursor = c.to;
  }
  stripped += inner.slice(cursor);
  const stacked = /^((?:\{==)+)([\s\S]*?)((?:==\})+)$/.exec(stripped.trim());
  if (
    stacked &&
    stacked[1].length === stacked[3].length &&
    !/\{==|==\}/.test(stacked[2])
  ) {
    return null;
  }
  // A residue holding other markup (an interleave) is beyond a mechanical heal.
  if (/\{>>|<<\}/.test(stripped.replace(/`[^`]*`/g, ""))) return null;

  // A comment inside the span that is anchored on its own inner highlight
  // (`{==a long span with {==word==}{>>?<<} in it==}{>>…<<}`), or a reply
  // threaded under one, is a nested anchor, which displays fine — it only breaks
  // when the outer thread carries a SUGGEST that needs the span (#65). A bare
  // comment inside the span (a reply typed into the anchor, #72) always breaks
  // the thread's anchor.
  const bare = comments.some((c, k) => {
    const lead = inner.slice(k === 0 ? 0 : comments[k - 1].to, c.from);
    if (k > 0 && THREAD_GAP.test(lead)) return false; // a reply: inherits its root
    return !/==\}\s*$/.test(lead);
  });

  // Rebuild the words, byte for byte outside the comments and the inner anchor
  // delimiters (literals untouched). The one space a point comment was inserted
  // with (`@david {>>…<<}==}`) is dropped; when the comment ended the span, that
  // space is kept as `trailing` so the heal can put it back outside if needed.
  let prose = "";
  let trailing = "";
  cursor = 0;
  const pieces: { from: number; to: number }[] = [];
  for (const c of comments) {
    let end = c.from;
    const atEnd = /^(?:==\})*$/.test(inner.slice(c.to).replace(/\{>>[\s\S]*?<<\}/g, ""));
    const next = inner[c.to] ?? "";
    if (end > cursor && /\s/.test(inner[end - 1]) && (atEnd || /\s/.test(next))) {
      if (atEnd) trailing = inner[end - 1];
      end -= 1;
    }
    pieces.push({ from: cursor, to: end });
    cursor = c.to;
  }
  pieces.push({ from: cursor, to: inner.length });
  for (const piece of pieces) {
    for (let i = piece.from; i < piece.to; ) {
      // A complete tracked change is opaque: its body is content, delimiters and all.
      if (inner[i] === "{" && !inner.startsWith("{==", i)) {
        const m = matchConstructAt(inner, i);
        if (m && m.to <= piece.to) {
          prose += inner.slice(i, m.to);
          i = m.to;
          continue;
        }
      }
      if (
        (inner.startsWith("{==", i) || inner.startsWith("==}", i)) &&
        i + 3 <= piece.to &&
        !positionInRanges(base + i, literals)
      ) {
        i += 3;
        continue;
      }
      prose += inner[i];
      i += 1;
    }
  }

  // The anchor's own thread: the root by the anchor rule, replies by the thread
  // rule (as groupThreads), so a separate card after it is never crossed.
  let threadEnd = close + 3;
  const thread: string[] = [];
  for (;;) {
    const gap = /^[ \t]*/.exec(content.slice(threadEnd))![0];
    const at = threadEnd + gap.length;
    if (!content.startsWith("{>>", at)) break;
    if (!(thread.length === 0 ? ANCHOR_GAP : THREAD_GAP).test(gap)) break;
    const s = scanComment(content, at);
    if (!s || s.nested) break;
    thread.push(s.outerBody);
    threadEnd = s.end;
  }
  const outerSuggests = thread.some(
    (body) => suggestionReplacement(parseCommentInner(body).body) !== null,
  );
  if (!bare && !outerSuggests) return null;
  const lifted = comments.map((c) => inner.slice(c.from, c.to));
  const healable = !lifted.some((raw) => {
    const s = scanComment(raw, 0);
    return s !== null && suggestionReplacement(parseCommentInner(s.outerBody).body) !== null;
  });
  return { open, close, threadEnd, prose, trailing, lifted, healable };
}

/** Every comment-in-anchor defect, outermost first, in document order. */
function commentInAnchorRuns(content: string): CommentInAnchor[] {
  const out: CommentInAnchor[] = [];
  const literals = cachedLiteralRanges(content);
  for (let i = content.indexOf("{=="); i >= 0; i = content.indexOf("{==", i + 3)) {
    if (positionInRanges(i, literals)) continue; // an example in code, not an anchor
    const a = commentInAnchorAt(content, i);
    if (!a) continue;
    out.push(a);
    i = a.close; // inner opens belong to this defect
  }
  return out;
}

/** ONE comment-in-anchor repair: the span keeps its words, the anchor's own thread
 *  stays on it, and the comments found inside the span move to the END of that
 *  thread — so every word and comment survives and a SUGGEST on it applies again. */
function healOneCommentInAnchor(content: string): string | null {
  const a = commentInAnchorRuns(content).find((run) => run.healable);
  if (!a) return null;
  const anchor = a.prose.trim() ? `{==${a.prose}==}` : a.prose;
  const after = content.slice(a.threadEnd);
  // The dropped separator may have belonged to the span (`{==word {>>…<<}==}tail`):
  // put it back after the thread unless whitespace already follows there.
  // Only the same horizontal whitespace already following makes it redundant; a
  // newline does not (two trailing spaces are a Markdown hard break).
  const space = a.trailing && after !== "" && !/^[ \t]/.test(after) ? a.trailing : "";
  return (
    content.slice(0, a.open) +
    anchor +
    content.slice(a.close + 3, a.threadEnd) +
    a.lifted.join("") +
    space +
    after
  );
}

/** ONE comment that lost its body with its colon leaked into the prose —
 *  `{>>@claude<<}:  The rock` (a mangled empty `SUGGEST:`, #47). Nothing of the
 *  author's prose is in it, so it goes, with the stray colon and one space. */
function healOneMangledComment(content: string): string | null {
  const literals = cachedLiteralRanges(content);
  for (const m of content.matchAll(/\{>>@[^\s:{}<>]+<<\}: ?/g)) {
    if (positionInRanges(m.index, literals)) continue; // an example in code
    return content.slice(0, m.index) + content.slice(m.index + m[0].length);
  }
  return null;
}

/** ONE unterminated comment that carries no words — only an author and/or an
 *  empty `SUGGEST:` before the end of its line (#47). It is removed to the end of
 *  the line; an unterminated comment with real words stays for a human. */
function healOneEmptyDanglingComment(content: string): string | null {
  const re = /\{>>[ \t]*(?:@[^\s:{}<>]+:)?[ \t]*(?:SUGGEST(?:\[g:[^\]\s]+\])?:)?[ \t]*(?=\r?\n|$)/g;
  const literals = cachedLiteralRanges(content);
  for (let m = re.exec(content); m; m = re.exec(content)) {
    if (positionInRanges(m.index, literals)) continue; // an example in code
    if (scanComment(content, m.index)) continue; // it closes later — not dangling
    return content.slice(0, m.index) + content.slice(m.index + m[0].length);
  }
  return null;
}

/**
 * Every mechanical repair, applied to a fixpoint: nested comments flattened,
 * trapped comments moved out of tracked changes, multi-block anchors re-anchored
 * on their final block. What it can't fix (true danglings, cross-construct
 * interleaves) is left for the validator to keep flagging.
 */
export function healDocument(content: string): string {
  let out = healNestedComments(content);
  for (let guard = 0; guard < 500; guard++) {
    const next =
      healOneMultilineComment(out) ??
      healOneCommentInWrapper(out) ??
      healOneMultiBlockAnchor(out) ??
      healOneCommentInAnchor(out) ??
      healOneMangledComment(out) ??
      healOneEmptyDanglingComment(out);
    if (next === null) break;
    out = next;
  }
  return out;
}

// ── Hard-wrap (#10): reflow prose to a max width, markup-safe ──────────────────
// Like vim's textwidth: plain paragraphs are unwrapped then greedily refilled at
// `width` columns. Everything that isn't a plain paragraph is left verbatim —
// headings, blockquotes, lists, tables, fenced/indented code, HTML blocks — and
// CriticMarkup constructs are ATOMIC: a break never lands inside one, so every
// token's raw stays byte-identical (content-derived ids and persisted seen-keys
// survive a wrap). Only whitespace OUTSIDE constructs changes. A construct longer
// than the width overflows its line rather than being split. Idempotent.

const NON_PARAGRAPH_LINE =
  /^(\s{4,}|\t|#{1,6}\s|>|\s*([-*+]|\d{1,3}[.)])\s|\||```|~~~|<\/?[a-zA-Z])/;

/** Greedy refill of one paragraph block. Break points are whitespace runs OUTSIDE
 *  any CriticMarkup construct; whitespace inside a construct (incl. newlines in a
 *  comment body) is preserved verbatim as part of its atom. */
const WS = /\s/;

function wrapParagraph(para: string, width: number): string {
  const tokens = scanTokens(para);
  let t = 0; // tokens are sorted by from; advance a cursor instead of re-scanning
  const atoms: string[] = [];
  let cur = "";
  for (let i = 0; i < para.length; i++) {
    while (t < tokens.length && tokens[t].to <= i) t++;
    const insideToken = t < tokens.length && i >= tokens[t].from && i < tokens[t].to;
    if (!insideToken && WS.test(para[i])) {
      if (cur) {
        atoms.push(cur);
        cur = "";
      }
    } else {
      cur += para[i];
    }
  }
  if (cur) atoms.push(cur);

  const lines: string[] = [];
  let line = "";
  for (const a of atoms) {
    if (!line) line = a;
    else if (line.length + 1 + a.length <= width) line += ` ${a}`;
    else {
      lines.push(line);
      line = a;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/** The fenced code blocks of `lines` (the same fence rule hardWrap applies), as
 *  offset ranges. Construct-shaped text inside them is an example. A plain line
 *  scan, so markup elsewhere can't make prose look like code. */
function fencedCodeRanges(lines: string[]): SourceRange[] {
  const ranges: SourceRange[] = [];
  let at = 0;
  let open: number | null = null;
  for (const line of lines) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      if (open === null) open = at;
      else {
        ranges.push({ from: open, to: at + line.length });
        open = null;
      }
    }
    at += line.length + 1;
  }
  if (open !== null) ranges.push({ from: open, to: at });
  return ranges;
}

export function hardWrap(text: string, width = 88): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let inFence = false;
  // A construct is atomic over its WHOLE range (#122): a line that starts inside a
  // multi-line token is its continuation and goes wherever the token's first line
  // went, whatever block it looks like (quote, list, heading, blank, fence). A
  // whole-line insertion block stays a block (verbatim, never joined with prose),
  // and construct-shaped text inside code is an example, not a construct.
  const fenced = fencedCodeRanges(lines);
  const tokens = scanTokens(text).filter(
    (tok) =>
      (text.slice(tok.from, tok.to).includes("\n") || isStandaloneInsertion(text, tok)) &&
      !positionInRanges(tok.from, fenced),
  );
  let t = 0;
  let lineStart = 0;
  let lastToPara = false;
  const flush = () => {
    if (para.length) {
      out.push(wrapParagraph(para.join("\n"), width));
      para = [];
    }
  };
  for (const line of lines) {
    const start = lineStart;
    lineStart += line.length + 1;
    while (t < tokens.length && tokens[t].to <= start) t++;
    if (t < tokens.length && tokens[t].from < start) {
      (lastToPara ? para : out).push(line);
      continue;
    }
    lastToPara = false;
    if (t < tokens.length && tokens[t].from < lineStart && isStandaloneInsertion(text, tokens[t])) {
      flush();
      out.push(line);
      continue;
    }
    if (/^ {0,3}(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || line.trim() === "" || NON_PARAGRAPH_LINE.test(line)) {
      flush();
      out.push(line);
      continue;
    }
    para.push(line);
    lastToPara = true;
  }
  flush();
  return out.join("\n");
}

// ── Markup validator (#18): positioned diagnostics for everything that leaks ──
// A single left-to-right pass with a highlight-delimiter stack, mirroring how the
// EDITOR actually resolves markup — so a stacked thread (`{=={==x==}{>>a<<}==}…`)
// and an anchor wrapping tracked changes are CLEAN, while anything that renders
// raw gets a diagnostic at the exact leaking delimiter. Replaces the comment-only
// warning count (which undercounted: leaking highlights were invisible to it).

export interface MarkupDiagnostic {
  from: number;
  to: number; // end of the offending delimiter
  kind: MarkupDiagnosticKind;
  message: string;
}

/** Delimiter defects render raw and block export; review-integrity defects are
 *  balanced markup whose meaning is broken (a SUGGEST with nothing to apply to). */
export type MarkupDiagnosticKind =
  | "dangling-open"
  | "stray-close"
  | "nested-comment"
  | "unparsed"
  | "comment-in-anchor"
  | "orphan-suggestion"
  | "unsafe-suggestion"
  | "mixed-suggestion"
  | "mangled-comment";

const LEAKING_KINDS = new Set<MarkupDiagnosticKind>([
  "dangling-open",
  "stray-close",
  "nested-comment",
  "unparsed",
]);

export type AcceptedMarkdownResult =
  | { ok: true; markdown: string }
  | { ok: false; diagnostics: MarkupDiagnostic[] };

const SIMPLE_CLOSE: Record<string, string> = { "{++": "++}", "{--": "--}", "{~~": "~~}" };
const STRAY_CLOSES = ["++}", "--}", "~~}", "<<}"];

/** Offset of the end of the current paragraph (the next blank line), or text end. */
function paragraphEnd(text: string, from: number): number {
  const m = BLANK_LINE.exec(text.slice(from));
  return m ? from + m.index : text.length;
}

export function validateMarkup(text: string): MarkupDiagnostic[] {
  const out = delimiterDiagnostics(text);
  out.push(...reviewIntegrityDiagnostics(text));
  out.sort((a, b) => a.from - b.from);
  // Markup-shaped text inside code is an example: nothing there renders raw.
  return out.filter((d) => !inLiteral(text, d.from));
}

/** The delimiter pass alone: every construct delimiter that renders raw. */
function delimiterDiagnostics(text: string): MarkupDiagnostic[] {
  const out: MarkupDiagnostic[] = [];
  const hlStack: number[] = [];
  const flushHlStack = () => {
    while (hlStack.length) {
      const p = hlStack.pop()!;
      out.push({
        from: p,
        to: p + 3,
        kind: "dangling-open",
        message: "highlight doesn't close in this paragraph — its {== renders raw",
      });
    }
  };

  // Markdown literals (code, URLs…) are skipped whole: a `{==` inside backticks
  // must neither leak nor pair with a `==}` in the prose after it.
  // An escape (`\{`) is left in: the editor renders `\{==x==}` as text either way.
  const literals = criticAwareLiteralRanges(text).filter((r) => !(r.to - r.from === 2 && text[r.from] === "\\"));
  let lit = 0;
  let i = 0;
  while (i < text.length) {
    while (lit < literals.length && literals[lit].to <= i) lit += 1;
    if (lit < literals.length && literals[lit].from <= i) {
      // A code block is a paragraph boundary of its own: no highlight survives it.
      if (literals[lit].block || text.slice(literals[lit].from, literals[lit].to).includes("\n")) flushHlStack();
      i = literals[lit].to;
      continue;
    }
    const ch = text[i];

    if (ch === "\n") {
      // Paragraph break: no construct survives it — any open highlight leaks.
      let j = i + 1;
      // `\r` too, so a CRLF blank line counts like an LF one (#96).
      while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\r")) j += 1;
      if (j < text.length && text[j] === "\n") flushHlStack();
      i += 1;
      continue;
    }

    if (ch === "{") {
      const open3 = text.slice(i, i + 3);

      if (open3 === "{>>") {
        const s = scanComment(text, i);
        if (!s) {
          out.push({ from: i, to: i + 3, kind: "dangling-open", message: "comment never closes (missing <<})" });
          i += 3;
          continue;
        }
        const raw = text.slice(i, s.end);
        if (s.nested) {
          // Healable: the per-issue review (HealReview) can pull the inner one out.
          out.push({ from: i, to: i + 3, kind: "nested-comment", message: "a comment is nested inside this comment — auto-fixable" });
          i = s.end;
          continue;
        }
        if (BLANK_LINE.test(raw)) {
          out.push({ from: i, to: i + 3, kind: "unparsed", message: "comment crosses a paragraph break — renders raw" });
          i += 3; // scan the body so inner constructs/closes get their own diagnostics
          continue;
        }
        if (NESTED_OPEN.test(raw.slice(3, -3))) {
          out.push({ from: i, to: i + 3, kind: "unparsed", message: "comment body contains markup delimiters — won't parse" });
          i += 3;
          continue;
        }
        i = s.end; // clean comment
        continue;
      }

      if (open3 in SIMPLE_CLOSE) {
        const m = matchConstructAt(text, i);
        if (m) {
          i = m.to; // parses — nothing inside a simple construct can leak
          continue;
        }
        const close = SIMPLE_CLOSE[open3];
        const closeAt = text.indexOf(close, i + 3);
        const blockEnd = paragraphEnd(text, i);
        if (closeAt === -1 || closeAt >= blockEnd) {
          out.push({ from: i, to: i + 3, kind: "dangling-open", message: `${open3} never closes in this paragraph` });
          i += 3;
          continue;
        }
        if (open3 === "{~~" && !text.slice(i + 3, closeAt).includes(SUBSTITUTE_ARROW)) {
          // One diagnostic for the whole arrowless substitution; consume it so the
          // ~~} isn't double-flagged.
          out.push({ from: i, to: i + 3, kind: "unparsed", message: "substitution is missing the ~> arrow — renders raw" });
          i = closeAt + close.length;
          continue;
        }
        // Close exists but the body swallows another construct's open — the open
        // renders raw; the inner construct (and the orphaned close) scan on their own.
        out.push({ from: i, to: i + 3, kind: "unparsed", message: `${open3} contains another construct's opening delimiter — won't parse` });
        i += 3;
        continue;
      }

      if (open3 === "{==") {
        hlStack.push(i);
        i += 3;
        continue;
      }

      i += 1;
      continue;
    }

    if (ch === "=" && text.startsWith("==}", i)) {
      if (hlStack.length) hlStack.pop();
      else out.push({ from: i, to: i + 3, kind: "stray-close", message: "==} with no matching {== — renders raw" });
      i += 3;
      continue;
    }

    const stray = STRAY_CLOSES.find((c) => text.startsWith(c, i));
    if (stray) {
      out.push({ from: i, to: i + 3, kind: "stray-close", message: `${stray} with no matching open — renders raw` });
      i += 3;
      continue;
    }

    i += 1;
  }

  flushHlStack(); // anything still open at EOF leaks
  return out;
}

/** Whether `{==span==}` scans back as exactly one highlight over exactly `span`
 *  (no blank line inside, no edge char joining a delimiter). */
function wrapsCleanly(span: string): boolean {
  const wrapped = `{==${span}==}`;
  return scanTokens(wrapped).some((t) => t.type === "highlight" && t.from === 0 && t.to === wrapped.length);
}

/** Whether a SUGGEST replacement would leave raw delimiters once applied as prose
 *  (`a ==} b`): such a card is not applicable, since Apply would break the
 *  markup (#94). */
export function replacementLeaks(replacement: string): boolean {
  return delimiterDiagnostics(replacement).length > 0;
}

/** Whether accepting SUGGEST `comment` would leave raw delimiters, judged in
 *  the document where its replacement would land. */
export function unsafeSuggestion(
  content: string,
  comment: CommentToken,
  tokens?: CritToken[],
  threads?: CommentThread[],
): boolean {
  const repl = suggestionReplacement(comment.body);
  if (repl === null) return false;
  if (replacementLeaks(repl)) return true; // leaks on its own, whatever surrounds it
  const toks = tokens ?? scanTokens(content);
  const hl = threadAnchorHighlightFor(content, comment, toks, threads);
  if (!hl) return false;
  const ths = threads ?? groupThreads(toks.filter((t): t is CommentToken => t.type === "comment"), content);
  const thread = ths.find((th) => th.comments.some((c) => c.from === comment.from));
  // Judge the whole paragraph after the splice against the paragraph before it,
  // so neither the text before the anchor (`    ==}` read as an indented code
  // block) nor an enclosing anchor balancing a stray `==}` can hide a leak.
  const start = suggestionAnchorStart(content, hl);
  const end = Math.max(thread?.to ?? hl.to, hl.to);
  const paraStart = (() => {
    const before = content.slice(0, start);
    const m = [...before.matchAll(/\r?\n[ \t]*\r?\n/g)].at(-1);
    return m ? m.index + m[0].length : 0;
  })();
  const paraEnd = paragraphEnd(content, end);
  const before = content.slice(paraStart, paraEnd);
  const after = content.slice(paraStart, start) + repl + content.slice(end, paraEnd);
  return delimiterDiagnostics(after).length > delimiterDiagnostics(before).length;
}

// A `SUGGEST:` marker anywhere in a body (the structured form must START with it).
const SUGGEST_MARKER = /\bSUGGEST(?:\[g:[^\]\s]+\])?:/;

/**
 * Balanced markup whose review meaning is broken (#65, #28, #72, #47): an anchor
 * whose span contains a comment (its thread can't anchor), a SUGGEST card with no
 * resolvable span (Apply is disabled), a comment mixing prose with `SUGGEST:`
 * (shows as a plain note), and a comment that lost its body (`{>>@claude<<}:`).
 * Reported beside the delimiter defects so the pill, `acm heal` and agents see
 * them; they never block export (nothing renders raw).
 */
function reviewIntegrityDiagnostics(text: string): MarkupDiagnostic[] {
  const out: MarkupDiagnostic[] = [];
  for (const a of commentInAnchorRuns(text)) {
    out.push({
      from: a.open,
      to: a.open + 3,
      kind: "comment-in-anchor",
      message: a.healable
        ? "a comment sits inside this highlight's span — its thread can't anchor; auto-fixable"
        : "a comment sits inside this highlight's span — its thread can't anchor; move it out by hand",
    });
  }
  const literals = cachedLiteralRanges(text);
  const tokens = scanTokens(text);
  const applicable = applicableSuggestionIds(text, tokens);
  for (const t of tokens) {
    if (t.type !== "comment" || positionInRanges(t.from, literals)) continue;
    if (suggestionReplacement(t.body) !== null) {
      if (!applicable.has(t.id)) {
        out.push(
          unsafeSuggestion(text, t, tokens)
            ? {
                from: t.from,
                to: t.from + 3,
                kind: "unsafe-suggestion",
                message: "SUGGEST replacement contains CriticMarkup delimiters, so applying it would break the markup — rewrite it",
              }
            : {
                from: t.from,
                to: t.from + 3,
                kind: "orphan-suggestion",
                message: "SUGGEST card has no anchored span, so it can't be applied — put {==the span==} right before it",
              },
        );
      }
    } else if (SUGGEST_MARKER.test(t.body)) {
      out.push({
        from: t.from,
        to: t.from + 3,
        kind: "mixed-suggestion",
        message:
          "this comment mixes prose with SUGGEST: — it shows as a plain note; put the suggestion in a comment of its own",
      });
    } else if (t.author === null && /^@[^\s:]+$/.test(t.body) && text[t.to] === ":") {
      out.push({
        from: t.from,
        to: t.from + 3,
        kind: "mangled-comment",
        message: "comment lost its body and leaked a colon into the prose — auto-fixable",
      });
    }
  }
  return out;
}

/** Produce the document's accepted Markdown without mutating the source. This is
 * the canonical projection for print/export: insertions and replacement text are
 * kept, deletions/comments are removed, and highlights keep their inner prose.
 * Malformed CriticMarkup is refused rather than leaking review delimiters into a
 * published artifact. */
export function acceptedMarkdown(text: string): AcceptedMarkdownResult {
  const literalRanges = markdownLiteralRanges(text);
  const diagnostics = validateMarkup(text).filter(
    (diagnostic) =>
      LEAKING_KINDS.has(diagnostic.kind) && !positionInRanges(diagnostic.from, literalRanges),
  );
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const acceptRange = (source: string, top = false): string => {
    const protectedRanges = markdownLiteralRanges(source);
    const tokens = [...scanTokens(source)]
      .filter((token) => !positionInRanges(token.from, protectedRanges))
      .sort(
        (a, b) => a.from - b.from || b.to - a.to,
      );
    // Top-level prose between tokens may still carry the wrapper delimiters of a
    // stacked thread (`{=={==span==}{>>a<<}==}{>>b<<}`), which never tokenise.
    // Drop only delimiters that pair up as such wrappers, outside literals; a
    // lone `==}` (inside a tracked change, or closing an escaped `\{==`) is text.
    const wrappers = new Set<number>();
    if (top) {
      const opens: number[] = [];
      let t = 0;
      for (let i = 0; i < source.length; ) {
        while (t < tokens.length && tokens[t].to <= i) t += 1;
        if (t < tokens.length && tokens[t].from <= i && i < tokens[t].to) {
          i = tokens[t].to;
          continue;
        }
        if (!positionInRanges(i, protectedRanges)) {
          if (source.startsWith("{==", i)) {
            opens.push(i);
            i += 3;
            continue;
          }
          if (source.startsWith("==}", i) && opens.length > 0) {
            wrappers.add(opens.pop()!);
            wrappers.add(i);
            i += 3;
            continue;
          }
        }
        i += 1;
      }
    }
    let cursor = 0;
    let accepted = "";
    const prose = (from: number, to: number): string => {
      let piece = "";
      for (let i = from; i < to; ) {
        if (wrappers.has(i)) {
          i += 3;
          continue;
        }
        piece += source[i];
        i += 1;
      }
      return piece;
    };

    for (const token of tokens) {
      // scanTokens deliberately emits tracked changes contained by a highlight.
      // Once the outer token has been handled recursively, skip those duplicate
      // absolute ranges at this level.
      if (token.from < cursor) continue;
      accepted += prose(cursor, token.from);
      switch (token.type) {
        case "insert":
          accepted += acceptRange(token.inner);
          break;
        case "delete":
        case "comment":
          break;
        case "substitute":
          accepted += acceptRange(token.newText);
          break;
        case "highlight":
          accepted += acceptRange(token.inner);
          break;
      }
      cursor = token.to;
    }

    return accepted + prose(cursor, source.length);
  };

  return { ok: true, markdown: acceptRange(text, true) };
}

/**
 * Whether `[from,to)` can be wrapped as a `{==span==}` anchor without corrupting
 * markup. THE shared gate for every span-wrapping writer (the UI's add-comment
 * composer and the `acm suggest` verb), so human and agent agree on what anchors.
 * Allowed: clean prose, and complete tracked changes ({++/--/~~}) wholly inside
 * the selection — the nesting-aware grammar (lib + lezer) parses
 * `{==a {++b++} c==}`. Refused: an empty/blank span, a span crossing a paragraph
 * break (single-block), a selection that CUTS a construct, contained
 * comments/highlights (they'd fight the stacked-thread model), and half-typed
 * delimiters outside a complete construct.
 */
export function wrappableSpan(content: string, from: number, to: number): boolean {
  if (to <= from) return false;
  const span = content.slice(from, to);
  if (!span.trim()) return false;
  if (BLANK_LINE.test(span)) return false; // crosses a paragraph break → would leak
  // Markup inside a code span (or any Markdown literal) renders as literal text
  // (#71): the span must contain a literal whole, and never touch a multi-line one.
  for (const r of cachedLiteralRanges(content)) {
    if (r.to <= from || r.from >= to) continue;
    const start = r.widenFrom ?? r.from;
    if (r.block || start < from || r.to > to || content.slice(r.from, r.to).includes("\n")) return false;
  }
  let residue = "";
  let cursor = from;
  for (const t of scanTokens(content)) {
    if (t.to <= from || t.from >= to) continue; // clear of the selection
    if (t.from < from || t.to > to) return false; // selection cuts through markup
    if (t.type === "comment" || t.type === "highlight") return false;
    residue += content.slice(cursor, t.from); // contained tracked change: skip its raw
    cursor = Math.max(cursor, t.to);
  }
  residue += content.slice(cursor, to);
  // Delimiters in the prose between/around complete constructs would mis-bound the wrap.
  if (/\{(\+\+|--|~~|==|>>)/.test(residue) || residue.includes("==}") || residue.includes("<<}")) {
    return false;
  }
  // The span's own edge chars can join the wrap's delimiters into another one
  // (`set {` + `==}` reads as a second `{==`, #93): the wrapped span must scan
  // back as exactly one highlight over exactly these bytes.
  const wrapped = content.slice(0, from) + "{==" + span + "==}" + content.slice(to);
  const end = to + 6;
  return scanTokens(wrapped).some((t) => t.type === "highlight" && t.from === from && t.to === end);
}

/** Insert a formatted point comment into `content` at character offset
 *  `anchorOffset`, returning the new full content. Used by the server's
 *  POST /api/comment; placement follows {@link pointCommentInsert}. */
export function insertComment(
  content: string,
  anchorOffset: number,
  text: string,
  author: string,
): string {
  const { from, insert } = pointCommentInsert(content, anchorOffset, formatComment(author, text));
  return content.slice(0, from) + insert + content.slice(from);
}

/**
 * Where a POINT comment `marker` typed at `at` lands, and the exact text to insert.
 * Shared by the editor's composer fallback and POST /api/comment. It never lands
 * inside markup or a code span:
 *   • inside an anchor (`{==span==}` and its thread) → after the thread's last
 *     `<<}`, with no space, so it joins that thread as a reply (#72) instead of
 *     sitting inside the span and breaking the thread's anchor;
 *   • inside a comment or tracked change → just past it;
 *   • inside a Markdown literal (an inline code span, a URL…) → just past it (#71);
 * and a separating space is added when the preceding char isn't whitespace.
 */
export function pointCommentInsert(
  content: string,
  at: number,
  marker: string,
): { from: number; insert: string } {
  let pos = Math.max(0, Math.min(at, content.length));
  const literals = cachedLiteralRanges(content);
  // Markup-shaped text inside a code span is an example, not a construct.
  const tokens = scanTokens(content).filter((t) => !positionInRanges(t.from, literals));
  for (let guard = 0; guard < 64; guard++) {
    const anchorEnd = enclosingAnchorEnd(content, pos, literals);
    if (anchorEnd !== null) return { from: anchorThreadEnd(content, anchorEnd, tokens), insert: marker };
    // A code or HTML block, edges included: anything on its first or closing line
    // would break the fence or the indent, so the comment becomes its own
    // paragraph after the block.
    const block = literals.find(
      (r) => (r.block || content.slice(r.from, r.to).includes("\n")) && r.from <= pos && pos <= r.to,
    );
    if (block) {
      const end = block.to;
      const trail = end === content.length || content.startsWith("\n\n", end) ? "" : content[end] === "\n" ? "\n" : "\n\n";
      return { from: end, insert: `\n\n${marker}${trail}` };
    }
    const enclosing =
      tokens.find((t) => t.type !== "highlight" && t.from < pos && pos < t.to) ??
      literals.find((r) => r.from < pos && pos < r.to);
    if (!enclosing) break;
    pos = enclosing.to;
  }
  const prev = pos > 0 ? content[pos - 1] : "";
  return { from: pos, insert: pos > 0 && !/\s/.test(prev) ? ` ${marker}` : marker };
}

/** End of the thread anchored on highlight `hl`, or `hl.to` when it carries no
 *  comment yet. The root attaches by the anchor rule (ANCHOR_GAP); each reply
 *  after it by the thread rule (THREAD_GAP), the same one groupThreads uses, so a
 *  whitespace-separated comment that is its own card is not crossed. */
function anchorThreadEnd(content: string, closeEnd: number, tokens: CritToken[]): number {
  const comments = tokens.filter((t) => t.type === "comment" && t.from >= closeEnd);
  let end = closeEnd;
  for (const c of comments) {
    const gap = content.slice(end, c.from);
    if (!(end === closeEnd ? ANCHOR_GAP : THREAD_GAP).test(gap)) break;
    end = c.to;
  }
  return end;
}

/** End (just past `==}`) of the innermost anchor whose span holds `pos`, or null.
 *  Found from balanced `{==`/`==}` pairs, so an outer anchor that wraps a whole
 *  nested thread (and so never tokenises) still counts (#113). */
function enclosingAnchorEnd(content: string, pos: number, literals: SourceRange[]): number | null {
  let best: { open: number; end: number } | null = null;
  for (let o = content.indexOf("{=="); o >= 0 && o < pos; o = content.indexOf("{==", o + 3)) {
    if (positionInRanges(o, literals)) continue;
    const close = findHighlightClose(content, o, literals);
    // A highlight is single-block: a pair across a blank line is no anchor.
    if (close < 0 || close >= paragraphEnd(content, o) || pos >= close + 3) continue; // inside `==}` counts as inside
    if (!best || o > best.open) best = { open: o, end: close + 3 };
  }
  return best ? best.end : null;
}

// One-entry cache: the composer, `acm suggest` and the spell pass call the span
// gate repeatedly on the same document; parse its Markdown literals once.
let literalCache: { content: string; ranges: SourceRange[] } | null = null;
/** Markdown literal ranges with every comment blanked out first (same offsets,
 *  newlines kept), so a backtick inside one comment can't pair with a backtick
 *  in another and turn the markup between them into a code span (#116). */
function criticAwareLiteralRanges(text: string, options: { wholeLinks?: boolean } = {}): SourceRange[] {
  let masked = "";
  let cursor = 0;
  // A comment-shaped run that starts inside real code (`{>>` quoted in one code
  // span, `<<}` in another) is an example, not a comment: it stays unmasked.
  const raw = markdownLiteralRanges(text);
  for (const t of scanTokens(text)) {
    if (t.type !== "comment" || t.from < cursor || positionInRanges(t.from, raw)) continue;
    // Keep the `{>>` and `<<}` delimiters and blank only the body: no leading
    // indent (an indented code block), a bare URL still ends at `{>>`, and no
    // `<` can open an HTML tag with the prose after it.
    masked +=
      text.slice(cursor, t.from) + t.raw.slice(0, 3) + t.raw.slice(3, -3).replace(/[^\n]/g, " ") + t.raw.slice(-3);
    cursor = t.to;
  }
  return markdownLiteralRanges(masked + text.slice(cursor), options);
}

function cachedLiteralRanges(content: string): SourceRange[] {
  if (literalCache?.content !== content) {
    literalCache = { content, ranges: criticAwareLiteralRanges(content, { wholeLinks: true }) };
  }
  return literalCache.ranges;
}

/** Whether offset `i` sits in a Markdown literal (code, a URL…): CriticMarkup-
 *  shaped text there is an example, never markup to diagnose or heal. */
function inLiteral(content: string, i: number): boolean {
  return positionInRanges(i, cachedLiteralRanges(content));
}

/**
 * Widen a selection so it never cuts a single-line Markdown literal — most often
 * an inline code span: selecting `bunx` inside `` `bunx --bun …` `` widens to the
 * whole code span, backticks included, so the anchor wraps it instead of putting
 * CriticMarkup inside the backticks, where it renders as literal text (#71).
 * Multi-line literals (fenced code) are left alone; wrappableSpan refuses them.
 */
export function widenToLiterals(content: string, from: number, to: number): { from: number; to: number } {
  let a = from;
  let b = to;
  for (const r of cachedLiteralRanges(content)) {
    if (r.to <= a || r.from >= b) continue;
    if (r.block || content.slice(r.from, r.to).includes("\n")) continue;
    a = Math.min(a, r.widenFrom ?? r.from);
    b = Math.max(b, r.to);
  }
  return { from: a, to: b };
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

/** Accepted-prose words per A4 page (11pt single-spaced ballpark) — the one
 *  pagination constant; UI copy derives from it too. */
export const WORDS_PER_A4_PAGE = 550;

/**
 * Where A4 page breaks fall, estimated the way a STANDARD document would paginate
 * (≈550 accepted-prose words per page — 11pt single-spaced, GDocs/Word ballpark) —
 * NOT by rendered screen height, which inflates the count ~2× (editor typography
 * is roomier than print). Each break is a 1-based line number plus how far
 * through that line's words the boundary falls (for interpolation inside long
 * soft-wrapped paragraph lines), plus the page total. Word counting matches {@link countWords} (comments
 * and deletions aren't prose), applied per line.
 */
export function pageBreakLines(
  text: string,
  wordsPerPage = WORDS_PER_A4_PAGE,
): { breaks: { line: number; frac: number }[]; pages: number } {
  // countWords is applied PER LINE below, but comments/deletions may span lines
  // (multi-line reply bodies) — a per-line regex can't strip an unclosed half and
  // would count raw delimiter fragments as words. Blank them out FIRST, replacing
  // every non-newline char with a space so line indices stay aligned.
  const blanked = text.replace(/\{>>[\s\S]*?<<\}|\{--[\s\S]*?--\}/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  const lines = blanked.split("\n");
  const breaks: { line: number; frac: number }[] = [];
  let words = 0;
  let nextBoundary = wordsPerPage;
  for (let i = 0; i < lines.length; i++) {
    const w = countWords(lines[i]);
    if (w === 0) continue;
    const before = words;
    words += w;
    // STRICTLY greater: a boundary landing exactly on the doc's last word fills
    // the page without starting a new one (no phantom trailing divider).
    while (words > nextBoundary) {
      // The boundary falls WITHIN this (possibly paragraph-long, soft-wrapped)
      // line — record how far through, so the renderer can interpolate the
      // divider inside the line's rendered block instead of snapping to its end.
      breaks.push({ line: i + 1, frac: (nextBoundary - before) / w });
      nextBoundary += wordsPerPage;
    }
  }
  return { breaks, pages: Math.max(1, Math.ceil(words / wordsPerPage)) };
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
  // The anchor is found by the same gap-tolerant rule apply uses (a stray space
  // between `==}` and the run must not leave an orphaned highlight behind); the
  // gap is swallowed with the markup.
  const hl = anchorHighlightFor(content, { from: runFrom });
  if (!hl || hl.type !== "highlight") {
    return { from: runFrom, to: runTo, insert: "" }; // point comment — just drop it
  }
  // Swallow any outer `{==` opens stacked immediately before the inner highlight.
  return { from: suggestionAnchorStart(content, hl), to: runTo, insert: hl.inner };
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
    if (inLiteral(content, i)) continue; // an example in code stays byte-identical (#97)
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

/** List each malformed (nested) comment: its offset + a short preview of the text
 *  that wraps the nested one — for a "problems"-style list with jump + heal. */
export function nestedCommentIssues(content: string): { from: number; preview: string }[] {
  const out: { from: number; preview: string }[] = [];
  for (let i = content.indexOf("{>>"); i >= 0; i = content.indexOf("{>>", i + 3)) {
    if (inLiteral(content, i)) continue; // an example in code stays byte-identical (#97)
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
      if (inLiteral(out, i)) continue; // an example in code stays byte-identical (#97)
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
  if (!content.startsWith("{>>", from) || inLiteral(content, from)) return null;
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

/** Content identity of a comment for "seen" tracking, keyed by author+body so it
 *  survives the positional-id shifts that edits cause. NUL separator (written as
 *  an escape, not a raw byte: a raw NUL makes every tool treat this file as
 *  binary): un-typeable, so "a b"+"c" can never collide with "a"+"b c". The escape
 *  keeps the exact runtime string — stored per-document seen-keys (localStorage +
 *  ~/.config/acm) stay valid. Shared by the GUI (useSeenState) and the CLI
 *  (`acm threads`). */
export function commentKey(c: { author: string | null; body: string }): string {
  return `${c.author ?? ""}\u0000${c.body}`;
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

/**
 * Build the right-margin cards: a SUGGESTION card per `{++/--/~~}` (claiming any
 * comments directly adjacent after it as replies — so a suggestion can spawn a
 * conversation), plus COMMENT-thread cards for every comment NOT claimed by a
 * suggestion (the existing highlight-anchored / standalone threads). Sorted by
 * document offset so the sidebar lays them out top-to-bottom.
 *
 * Adjacency uses the same THREAD_GAP as comment threads: only whitespace / orphaned
 * highlight-close markers may sit between a suggestion and its reply, so a comment
 * anchored to a following `{==highlight==}` is NOT mis-claimed.
 */
export function groupCards(tokens: CritToken[], text: string): SidebarCard[] {
  const inOrder = [...tokens].sort((a, b) => a.from - b.from);
  const claimed = new Set<string>();
  const cards: SidebarCard[] = [];

  for (let i = 0; i < inOrder.length; i++) {
    const t = inOrder[i];
    if (t.type !== "insert" && t.type !== "delete" && t.type !== "substitute") continue;
    const replies: CommentToken[] = [];
    let cursorTo = t.to;
    for (let j = i + 1; j < inOrder.length; j++) {
      const n = inOrder[j];
      if (n.type !== "comment") break; // only adjacent comments thread onto a suggestion
      if (!THREAD_GAP.test(text.slice(cursorTo, n.from))) break;
      replies.push(n);
      claimed.add(n.id);
      cursorTo = n.to;
    }
    cards.push({
      kind: "suggestion",
      id: t.id,
      from: t.from,
      to: cursorTo,
      suggestion: t as SuggestionToken,
      standalone: t.type === "insert" && isStandaloneInsertion(text, t),
      comments: replies,
    });
  }

  const freeComments = inOrder.filter((t): t is CommentToken => t.type === "comment" && !claimed.has(t.id));
  for (const th of groupThreads(freeComments, text)) {
    cards.push({ kind: "comment", id: th.id, from: th.from, to: th.to, comments: th.comments });
  }

  cards.sort((a, b) => a.from - b.from);
  return cards;
}

// ── Structured suggestions (tool-safe, forward-compatible) ─────────────────────
// An agent can't safely nest an inline {~~old~>new~~} inside a comment-anchored
// {==span==} — the highlight stops parsing and the braces leak. So a suggestion to
// REPLACE an anchored span is written as a structured comment instead:
//
//     {==the exact span==}{>>@claude: SUGGEST: the proposed new wording<<}
//
// It never nests, never corrupts. ACM recognises the `SUGGEST:` body, shows the
// proposed wording as a real suggested edit, and can apply it by replacing the
// anchored span (anchor-targeted — no brace-grammar fight). The pair {anchor span,
// replacement} is all a future inline accept/reject needs, so existing suggestions
// auto-upgrade.

// `SUGGEST: new wording` — optionally tagged with a group id, `SUGGEST[g:7a]: …`,
// so a SET of suggestions can be accepted/rejected as one unit (#21). The tag
// lives inside the comment body, so the substrate stays plain CriticMarkup.
// Only the envelope's ONE separator space after the colon is stripped (ADR 0003):
// whitespace the replacement was written with is part of the proposal, so a span
// that starts with a space keeps it on Apply (#75: "used by400+").
const SUGGESTION_PREFIX = /^\s*SUGGEST(?:\[g:([^\]\s]+)\])?: ?([\s\S]*)$/;

/** If `body` is a structured suggestion, the proposed replacement text (may be ""
 *  → suggest deleting the span); otherwise null. A group tag is NOT part of the
 *  replacement. */
export function suggestionReplacement(body: string): string | null {
  const m = body.match(SUGGESTION_PREFIX);
  return m ? m[2] : null;
}

/** The reply that asks an agent for a SUGGEST on a thread (#76; the card's Ask
 *  agent action). Plain words, so an agent reading the raw file understands it. */
export const EDIT_REQUEST_TEXT = "please suggest an edit";

/** Whether a comment body is an edit request (case and trailing `.`/`!` ignored). */
export function isEditRequestBody(body: string): boolean {
  return body.trim().replace(/[.!]+$/, "").toLowerCase() === EDIT_REQUEST_TEXT;
}

/** The suggestion-group id (`SUGGEST[g:7a]: …` → "7a"), or null for an untagged
 *  suggestion / a non-suggestion body. */
export function suggestionGroupId(body: string): string | null {
  const m = body.match(SUGGESTION_PREFIX);
  return m ? (m[1] ?? null) : null;
}

/**
 * The highlight that ANCHORS a comment: the closest highlight whose close is
 * separated from the comment's open by only ANCHOR_GAP noise (whitespace +
 * orphaned `{==` / `==}` delimiters, in any mix) — a SUPERSET of the THREAD_GAP rule
 * groupCards threads by (ANCHOR_GAP also tolerates a bare stray space; see its
 * definition below). Exporting this as the ONE anchor lookup means "this comment is
 * anchored to a span" can't disagree between the sidebar (which shows the
 * Suggested-edit card) and applySuggestionEdit (which performs it). Returns the
 * innermost/closest such highlight, or null (e.g. a point comment or a reply — not
 * anchored to a span).
 *
 * Tokens may be passed in to avoid re-scanning when the caller already has them.
 *
 * Exported so every reader of "what span is this thread about" (sidebar,
 * suggestCards, `acm threads`) shares the ONE adjacency rule.
 */
export function anchorHighlightFor(
  content: string,
  comment: { from: number },
  tokens?: CritToken[],
): CritToken | null {
  const toks = tokens ?? scanTokens(content);
  let best: CritToken | null = null;
  for (const t of toks) {
    if (t.type !== "highlight" || t.to > comment.from) continue;
    if (!ANCHOR_GAP.test(content.slice(t.to, comment.from))) continue;
    if (!best || t.to > best.to) best = t; // closest highlight before the comment
  }
  return best;
}

// The gap a comment may sit behind its anchoring highlight: only whitespace and
// orphaned highlight delimiters (`{==` / `==}`), in any mix, including none. A
// SUPERSET of THREAD_GAP — THREAD_GAP only allows whitespace ALONGSIDE a delimiter,
// whereas an anchor must also tolerate a bare stray space (`{==span==} {>>…<<}`)
// so an incidental space never silently turns a suggestion un-applyable. Any prose
// in the gap still disqualifies the highlight, so this can't bind the wrong span.
export const ANCHOR_GAP = /^(?:\s|\{==|==\})*$/;

/** The outermost stacked `{==` open at/before `hl.from` — the true start of the
 *  anchor run (a stacked same-anchor thread reads `{=={==span==}…==}…`). */
function suggestionAnchorStart(content: string, hl: CritToken): number {
  let start = hl.from;
  let end = hl.to;
  while (start >= 3 && content.slice(start - 3, start) === "{==") {
    // A stacked open of the SAME anchor closes after nothing but this anchor's
    // comments; an enclosing highlight that merely starts at the same word
    // closes after more prose, and its `{==` is not ours to strip (#95).
    const close = findHighlightClose(content, start - 3);
    if (close < 0) break;
    const between = content.slice(end, close).replace(/\{>>[\s\S]*?<<\}/g, "");
    if (!/^(?:\s|==\})*$/.test(between)) break;
    start -= 3;
    end = close + 3;
  }
  return start;
}

/**
 * The highlight anchoring a SUGGEST comment, INCLUDING when the comment is a reply
 * deeper in the thread (not adjacent to the highlight). A reply has its parent
 * comment(s) between it and the span, so the direct lookup fails — we then walk to
 * the thread ROOT and use the highlight the root is anchored to. So a suggestion
 * dropped anywhere in a conversation still targets the span the thread is about.
 */
export function threadAnchorHighlightFor(
  content: string,
  comment: CommentToken,
  tokens?: CritToken[],
  threads?: CommentThread[],
): CritToken | null {
  const toks = tokens ?? scanTokens(content);
  const direct = anchorHighlightFor(content, comment, toks);
  if (direct) return direct;
  // Reply: inherit the thread root's anchor. Reuse a prebuilt thread list when the
  // caller has one (callers in a per-comment loop must, else this is O(comments²)).
  const ths =
    threads ?? groupThreads(toks.filter((t): t is CommentToken => t.type === "comment"), content);
  const root = ths.find((th) => th.comments.some((c) => c.from === comment.from))?.comments[0];
  if (!root || root.from === comment.from) return null; // root itself had no anchor
  return anchorHighlightFor(content, root, toks);
}

/**
 * The edit that ACCEPTS or REJECTS a structured-suggestion comment — the single
 * source of truth for both, root or mid-thread reply. Rebuilds the whole anchor run
 * [anchorStart, thread.to):
 *   • span  ← the replacement (accept) or the original span (reject);
 *   • by default every OTHER comment is kept verbatim (discussion survives);
 *   • `resolve-thread` removes the complete discussion in that same ranged edit;
 *   • if no comments remain, the `{==…==}` wrapper collapses to plain prose.
 * So a sole-comment (root) suggestion collapses to clean prose exactly as before,
 * while accepting/rejecting a reply leaves the conversation intact on the (now
 * edited) span. A delete (empty replacement) that still has discussion drops the
 * wrapper and keeps the remaining comments as point comments (no empty `{====}`).
 * Returns null when `comment` isn't an anchored suggestion.
 */
export type SuggestionDiscussion = "keep-discussion" | "resolve-thread";

export function suggestionThreadEdit(
  content: string,
  comment: CommentToken,
  mode: "accept" | "reject",
  discussion: SuggestionDiscussion = "keep-discussion",
): { from: number; to: number; insert: string } | null {
  const repl = suggestionReplacement(comment.body);
  if (repl === null || (mode === "accept" && unsafeSuggestion(content, comment))) return null;
  const tokens = scanTokens(content);
  const threads = groupThreads(
    tokens.filter((t): t is CommentToken => t.type === "comment"),
    content,
  );
  const hl = threadAnchorHighlightFor(content, comment, tokens, threads);
  if (!hl || hl.type !== "highlight") return null;
  const thread = threads.find((th) => th.comments.some((c) => c.from === comment.from));
  if (!thread) return null;

  const newSpan = mode === "accept" ? repl : hl.inner;
  if (discussion === "resolve-thread") {
    return { from: suggestionAnchorStart(content, hl), to: thread.to, insert: newSpan };
  }
  // Applying a SUGGEST fulfils the edit requests posted before it: drop them with
  // the SUGGEST, or the thread would read as waiting on an edit that has landed
  // (#76). A request posted after it asks for something newer and stays.
  // Accepting a deletion leaves no span for a competing SUGGEST to target: left as
  // a point comment it would re-anchor on a neighbouring highlight and a later
  // accept would delete that prose (#91). The alternatives go with the span.
  const deleting = mode === "accept" && newSpan.length === 0;
  const remaining = thread.comments.filter(
    (c) =>
      c.from !== comment.from &&
      !(mode === "accept" && c.from < comment.from && isEditRequestBody(c.body)) &&
      !(deleting && suggestionReplacement(c.body) !== null),
  );
  const keptMarkup = remaining.map((c) => c.raw).join("");
  const insert =
    remaining.length === 0
      ? newSpan // sole comment → collapse wrapper to plain prose (today's behaviour)
      : newSpan.length === 0
        ? keptMarkup // delete + discussion → keep comments as point comments, no {====}
        : wrapsCleanly(newSpan)
          ? `{==${newSpan}==}${keptMarkup}` // edit span, keep the thread anchored
          : newSpan + keptMarkup; // can't be one highlight (a blank line, an edge `{`): point comments (#94)
  return { from: suggestionAnchorStart(content, hl), to: thread.to, insert };
}

/** Accept a structured-suggestion comment (keep the replacement). Thin wrapper over
 *  {@link suggestionThreadEdit}. Returns null when it isn't an anchored suggestion. */
export function applySuggestionEdit(
  content: string,
  comment: CommentToken,
): { from: number; to: number; insert: string } | null {
  return suggestionThreadEdit(content, comment, "accept");
}

/** Reject a structured-suggestion comment (keep the original span). Mirror of accept
 *  — like a native substitution's accept=new / reject=old. */
export function rejectSuggestionEdit(
  content: string,
  comment: CommentToken,
): { from: number; to: number; insert: string } | null {
  return suggestionThreadEdit(content, comment, "reject");
}

/** A SUGGEST: pair surfaced for INLINE substitution-style rendering: the anchor
 *  highlight to strike, the comment to replace with the proposed wording + ✓/✗,
 *  the replacement text, and whether a real discussion thread hangs off it (so the
 *  unified render doesn't hide that replies exist). */
export interface SuggestCard {
  hlFrom: number; // anchor highlight node start (render its span struck)
  hlTo: number;
  commentId: string; // the SUGGEST: comment's token id (so callers can key on it)
  commentFrom: number; // the SUGGEST: comment (replaced by the inline widget)
  commentTo: number;
  replacement: string;
  hasReplies: boolean; // the comment's thread carries ≥1 other message
  threadCount: number; // total messages in the thread (for the inline "N" badge)
  alternativeIndex: number; // nth suggestion on this anchor (0 = first; >0 → competing)
  groupId: string | null; // SUGGEST[g:id] — member of a multi-edit group (#21)
  groupSize: number; // members in that group (1 for ungrouped)
}

/**
 * Every anchored SUGGEST: pair in the document, for the editor's inline accept/
 * reject layer. Encapsulates the adjacency contract (anchorHighlightFor) so the
 * view stays presentational: it places decorations on real lezer nodes and only
 * consults this list to classify which highlight/comment is a suggestion.
 */
export function suggestCards(
  content: string,
  tokens?: CritToken[],
  options: { includeUnsafe?: boolean } = {},
): SuggestCard[] {
  const toks = tokens ?? scanTokens(content);
  // A SUGGEST example inside code is text, never a card.
  const comments = toks.filter((t): t is CommentToken => t.type === "comment" && !inLiteral(content, t.from));
  const threads = groupThreads(comments, content);
  const out: SuggestCard[] = [];
  const perAnchor = new Map<number, number>(); // hlFrom → suggestions seen so far
  for (const t of comments) {
    const repl = suggestionReplacement(t.body);
    // An unsafe replacement can be rejected but never applied, so it is left out
    // unless the caller is rejecting (the group planner).
    if (repl === null || (!options.includeUnsafe && unsafeSuggestion(content, t, toks, threads))) continue;
    // Resolve the span even for a reply deeper in the thread (inherits the root's).
    // Pass the prebuilt threads so the reply path stays O(comments), not O(comments²).
    const hl = threadAnchorHighlightFor(content, t, toks, threads);
    if (!hl || hl.type !== "highlight") continue;
    // hasReplies = a real conversation surrounds this suggestion (so the unified
    // render shows a "has discussion" cue and never hides the thread).
    const thread = threads.find((th) => th.comments.some((c) => c.from === t.from));
    const threadCount = thread ? thread.comments.length : 1;
    // Competing suggestions on one span: the 2nd+ get an index so the inline
    // render can separate them ("or …") instead of reading as one concatenated run.
    const alternativeIndex = perAnchor.get(hl.from) ?? 0;
    perAnchor.set(hl.from, alternativeIndex + 1);
    out.push({
      hlFrom: hl.from,
      hlTo: hl.to,
      commentId: t.id,
      commentFrom: t.from,
      commentTo: t.to,
      replacement: repl,
      hasReplies: threadCount > 1,
      threadCount,
      alternativeIndex,
      groupId: suggestionGroupId(t.body),
      groupSize: 1, // filled below once every member is known
    });
  }
  const groupSizes = new Map<string, number>();
  for (const s of out) if (s.groupId) groupSizes.set(s.groupId, (groupSizes.get(s.groupId) ?? 0) + 1);
  for (const s of out) if (s.groupId) s.groupSize = groupSizes.get(s.groupId)!;
  return out;
}

// ── Suggestion groups (#21): a set of edits accepted/rejected as ONE unit ──────
// Members are anchored SUGGEST comments sharing a `[g:id]` tag. Accept-all /
// reject-all turn into ONE batch of non-overlapping ranged edits, all in ORIGINAL
// coordinates — the editor dispatches them as a single transaction (atomic undo)
// and the CLI applies them back-to-front in one write.

/**
 * The accept/reject edits for every member of group `groupId`. A group applies
 * all or nothing: when any tagged member can't apply (its anchor is gone, or its
 * replacement would break the markup), no edit is returned and every member
 * counts in `skipped`, with `unanchored` naming how many blocked it (#104).
 * Ordinary Apply keeps the first of overlapping edits; Apply & resolve preserves
 * every conflicting thread, because resolving one would otherwise silently erase
 * its competing proposal.
 */
export function suggestionGroupEdits(
  content: string,
  groupId: string,
  mode: "accept" | "reject",
  discussion: SuggestionDiscussion = "keep-discussion",
): { edits: { from: number; to: number; insert: string }[]; skipped: number; unanchored: number } {
  const tokens = scanTokens(content);
  const comments = tokens.filter((t): t is CommentToken => t.type === "comment");
  const members = suggestCards(content, tokens, { includeUnsafe: mode === "reject" }).filter(
    (s) => s.groupId === groupId,
  );
  const tagged = comments.filter((c) => suggestionGroupId(c.body) === groupId && !inLiteral(content, c.from)).length;
  const unanchored = tagged - members.length;
  if (unanchored > 0) return { edits: [], skipped: tagged, unanchored };
  const edits: { from: number; to: number; insert: string }[] = [];
  let skipped = 0;
  for (const m of members) {
    const c = comments.find((t) => t.from === m.commentFrom);
    const e = c ? suggestionThreadEdit(content, c, mode, discussion) : null;
    if (e) edits.push(e);
    else skipped += 1;
  }
  edits.sort((a, b) => a.from - b.from);
  if (discussion === "resolve-thread") {
    // A resolve-range consumes its complete thread. If two group members share
    // that thread, keeping the first edit would silently remove the competing
    // proposal without applying or auditing it. Preserve the whole conflicting
    // thread instead; non-overlapping members in the group can still proceed.
    const conflicting = new Set<number>();
    for (let i = 0; i < edits.length; i += 1) {
      for (let j = i + 1; j < edits.length && edits[j].from < edits[i].to; j += 1) {
        conflicting.add(i);
        conflicting.add(j);
      }
    }
    skipped += conflicting.size;
    return { edits: edits.filter((_, index) => !conflicting.has(index)), skipped, unanchored: 0 };
  }
  const clean: typeof edits = [];
  for (const e of edits) {
    const prev = clean[clean.length - 1];
    if (prev && e.from < prev.to) skipped += 1;
    else clean.push(e);
  }
  return { edits: clean, skipped, unanchored: 0 };
}

/** Apply non-overlapping ranged edits to a string (back-to-front, so earlier
 *  offsets stay valid). The string-side mirror of a single CM transaction. */
export function applyRangedEdits(
  content: string,
  edits: { from: number; to: number; insert: string }[],
): string {
  let out = content;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  }
  return out;
}

/**
 * Ids of every `SUGGEST:` comment whose Apply is REAL (has a resolvable anchor),
 * for gating the sidebar Apply button. Exactly the comments {@link suggestCards}
 * surfaces — derived from that one pass rather than a second scan + anchor-resolve,
 * so the sidebar gate and the inline layer can never disagree on what's applyable.
 */
export function applicableSuggestionIds(content: string, tokens?: CritToken[]): Set<string> {
  return new Set(suggestCards(content, tokens).map((s) => s.commentId));
}

/** One member of a suggestion group, flattened for a "review the whole set" view:
 *  the anchored span it edits (struck "old" half) and the proposed wording (green
 *  "new" half; "" → delete the span). */
export interface SuggestionGroupMember {
  commentId: string; // the member's SUGGEST comment id (for jump/keying)
  from: number; // the member's comment offset, in document order
  anchorFrom: number; // the anchored span's start offset (for scroll + flash)
  anchorTo: number; // the anchored span's end offset
  anchorText: string; // the highlighted span being edited (the "old" text)
  replacement: string; // the proposed wording ("" → suggests deleting the span)
  isDelete: boolean; // replacement is empty/blank → a deletion
}

/**
 * Every member of suggestion group `groupId`, in document order, flattened to
 * {old span, new wording} pairs — the data a "see the whole group together" view
 * (popover / inline-expand / grouped panel) renders before an Apply-all. Derived
 * from the SAME {@link suggestCards} pass that drives the inline widgets and
 * {@link suggestionGroupEdits}, so the preview can never disagree with what
 * Apply-all will actually do. The anchored span is read from the member's own
 * highlight token (its `.inner`), so a stacked anchor reads its true span text.
 */
export function suggestionGroupMembers(
  content: string,
  groupId: string,
  tokens?: CritToken[],
): SuggestionGroupMember[] {
  const toks = tokens ?? scanTokens(content);
  const hlByFrom = new Map(
    toks.filter((t) => t.type === "highlight").map((t) => [t.from, t]),
  );
  return suggestCards(content, toks)
    .filter((s) => s.groupId === groupId)
    .map((s) => {
      const hl = hlByFrom.get(s.hlFrom);
      const anchorText =
        hl && hl.type === "highlight" ? hl.inner : content.slice(s.hlFrom + 3, s.hlTo - 3);
      return {
        commentId: s.commentId,
        from: s.commentFrom,
        // The visible span sits inside the `{==` / `==}` delimiters — flash that, not
        // the hidden markers, so the pulse lands on the words the reader sees.
        anchorFrom: s.hlFrom + 3,
        anchorTo: s.hlTo - 3,
        anchorText,
        replacement: s.replacement,
        isDelete: s.replacement.trim() === "",
      };
    });
}
