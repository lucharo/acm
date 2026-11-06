// ── Agent edit verbs (pure core) ───────────────────────────────────────────────
// The logic behind the `acm` CLI verbs, kept I/O-free so it's unit-testable: each
// function takes the document text + args and returns the new text (or a summary),
// throwing on an ambiguous/missing target. Anchoring is by UNIQUE TEXT MATCH (not
// raw offsets) so it survives edits and fails safe — nothing applies unless exactly
// one thread/span matches. The CLI layer adds read → snapshot → write → verify.

import {
  scanTokens,
  groupThreads,
  groupCards,
  commentKey,
  formatComment,
  canonicalizeCommentMarker,
  suggestionThreadEdit,
  resolveAnchorEdit,
  suggestionReplacement,
  suggestionGroupId,
  applicableSuggestionIds,
  anchorHighlightFor,
  threadAnchorHighlightFor,
  wrappableSpan,
  suggestionGroupEdits,
  applyRangedEdits,
  unsafeSuggestion,
} from "./criticmarkup";
import type { CommentToken, CommentThread } from "./criticmarkup";
import { threadEditRequested } from "./commentGroups";

/** Raised when a phrase/span matches zero or more than one target — the caller
 *  must resolve the ambiguity rather than guess. */
export class AmbiguityError extends Error {}

function applyEdit(content: string, e: { from: number; to: number; insert: string }): string {
  return content.slice(0, e.from) + e.insert + content.slice(e.to);
}

/** The single thread some of whose comment bodies contain `phrase`. Throws unless
 *  exactly one matches. */
export function findThread(content: string, phrase: string): CommentThread {
  const comments = scanTokens(content).filter((t): t is CommentToken => t.type === "comment");
  const threads = groupThreads(comments, content);
  const hits = threads.filter((th) => th.comments.some((c) => c.body.includes(phrase)));
  if (hits.length !== 1) {
    throw new AmbiguityError(`"${phrase.slice(0, 48)}" matched ${hits.length} threads (need exactly 1)`);
  }
  return hits[0];
}

/** The single SUGGEST card matched by `phrase`. Prefer the comment body (the
 *  proposed wording); when that yields no match, fall back to the anchor prose.
 *  The fallback is what makes an empty-replacement deletion addressable. */
export function findSuggestionComment(content: string, phrase: string): CommentToken {
  const tokens = scanTokens(content);
  const suggestions = tokens.filter(
    (t): t is CommentToken => t.type === "comment" && suggestionReplacement(t.body) !== null,
  );
  const bodyHits = suggestions.filter((comment) => comment.body.includes(phrase));
  const hits = bodyHits.length > 0
    ? bodyHits
    : suggestions.filter((comment) => {
        const anchor = threadAnchorHighlightFor(content, comment, tokens);
        return anchor?.type === "highlight" && anchor.inner.includes(phrase);
      });
  if (hits.length !== 1) {
    throw new AmbiguityError(`"${phrase.slice(0, 48)}" matched ${hits.length} suggestions (need exactly 1)`);
  }
  return hits[0];
}

/** Index of the sole occurrence of `span` that can be wrapped as a `{==…==}`
 *  anchor without corrupting markup (same wrappableSpan gate as the UI composer:
 *  clean prose OR complete tracked changes wholly inside the span). Throws unless
 *  exactly one wrappable occurrence exists. */
function uniqueProseIndex(content: string, span: string): number {
  const idxs: number[] = [];
  for (let i = content.indexOf(span); i >= 0; i = content.indexOf(span, i + 1)) idxs.push(i);
  const clean = idxs.filter((i) => wrappableSpan(content, i, i + span.length));
  if (clean.length !== 1) {
    throw new AmbiguityError(
      `"${span.slice(0, 48)}" occurs ${clean.length} times as a wrappable span (need exactly 1)`,
    );
  }
  return clean[0];
}

/** Append `marker` (raw CriticMarkup the agent composed) at the end of the thread
 *  matched by `phrase`, so it threads + inherits the anchor. Idempotent: if that
 *  thread already carries the exact marker, returns the document unchanged. (Only
 *  that thread: a short marker such as an empty deletion `SUGGEST:` legitimately
 *  repeats on other threads, #47.) */
export function appendToThread(content: string, phrase: string, marker: string): { content: string; skipped: boolean } {
  const th = findThread(content, phrase);
  if (th.comments.some((c) => c.raw === marker)) return { content, skipped: true };
  const pos = Math.max(...th.comments.map((c) => c.to)); // thread end
  return { content: content.slice(0, pos) + marker + content.slice(pos), skipped: false };
}

/** Reply to the thread matched by `phrase` with a plain comment by `author`. A
 *  `text` that is itself one whole comment marker (`{>>@claude: SUGGEST: <<}`, the
 *  form the skill documents for batches) is written as that comment, canonicalised,
 *  rather than escaped into the body of a new one (#47). */
export function addComment(content: string, phrase: string, author: string, text: string): string {
  const raw = text.trim();
  const marker =
    raw.startsWith("{>>") && raw.endsWith("<<}") && raw.indexOf("<<}") === raw.length - 3
      ? canonicalizeCommentMarker(raw)
      : formatComment(author, text);
  return appendToThread(content, phrase, marker).content;
}

/** Refuse a group id the SUGGEST grammar can't read back (#105): the id must
 *  round-trip through the parser, or the card isn't a suggestion at all. */
function assertSuggestionGroupId(group: string): void {
  if (suggestionGroupId(`SUGGEST[g:${group}]: x`) !== group) {
    throw new Error(`invalid group id "${group}" (no spaces or "]")`);
  }
}

/** Anchor a new SUGGEST: to the unique prose `span` — wraps it as
 *  `{==span==}{>>@author: SUGGEST: replacement<<}`. With `group`, the suggestion
 *  is tagged `SUGGEST[g:<group>]:` so the whole set can be accepted as one unit. */
export function addSuggestion(
  content: string,
  span: string,
  author: string,
  replacement: string,
  group?: string,
): string {
  if (group) assertSuggestionGroupId(group);
  const at = uniqueProseIndex(content, span);
  const prefix = group ? `SUGGEST[g:${group}]: ` : "SUGGEST: ";
  const marker = `{==${span}==}` + formatComment(author, prefix + replacement);
  return content.slice(0, at) + marker + content.slice(at + span.length);
}

/** Anchor a new comment on the unique prose `span` — wraps it as
 *  `{==span==}{>>@author: text<<}` (a new thread, not a reply). With `group`, the
 *  body is tagged `NOTE[g:<group>]: text` so related notes travel as one set (#77). */
export function addAnchoredComment(
  content: string,
  span: string,
  author: string,
  text: string,
  group?: string,
): string {
  if (group !== undefined && !/^[^\]\s]+$/.test(group)) {
    throw new Error(`invalid group id "${group}" (no spaces or "]")`);
  }
  const at = uniqueProseIndex(content, span);
  const marker = `{==${span}==}` + formatComment(author, group ? `NOTE[g:${group}]: ${text}` : text);
  return content.slice(0, at) + marker + content.slice(at + span.length);
}

export interface SuggestionAt {
  from: number;
  to: number;
  replacement: string;
}

/** Wrap each exact `[from,to)` span as a `SUGGEST[g:<group>]:` card (one group, so
 *  the set can be applied as one unit). Spans that can't be wrapped cleanly (inside
 *  an existing anchor or comment, cutting markup) are skipped and returned. Spans
 *  must not overlap. */
export function addSuggestionsAt(
  content: string,
  spans: readonly SuggestionAt[],
  author: string,
  group: string,
): { content: string; skipped: SuggestionAt[] } {
  assertSuggestionGroupId(group);
  const skipped: SuggestionAt[] = [];
  const wrappable = spans.filter((s) => {
    const ok = wrappableSpan(content, s.from, s.to);
    if (!ok) skipped.push(s);
    return ok;
  });
  let out = content;
  // Right to left, so earlier offsets stay valid as we splice.
  for (const s of [...wrappable].sort((a, b) => b.from - a.from)) {
    const marker =
      `{==${content.slice(s.from, s.to)}==}` +
      formatComment(author, `SUGGEST[g:${group}]: ${s.replacement}`);
    out = out.slice(0, s.from) + marker + out.slice(s.to);
  }
  return { content: out, skipped };
}

/** Accept or reject EVERY member of suggestion group `groupId` in one write.
 *  Throws when the group has no applyable members. Members that can't resolve
 *  (or would contradict an earlier member on the same thread) are skipped. */
export function resolveSuggestionGroup(
  content: string,
  groupId: string,
  mode: "accept" | "reject",
): { content: string; applied: number; skipped: number } {
  const { edits, skipped, unanchored } = suggestionGroupEdits(content, groupId, mode);
  if (unanchored > 0) {
    throw new AmbiguityError(
      `group "${groupId}": ${unanchored} member${unanchored === 1 ? " has" : "s have"} no anchored span (or an unsafe replacement), so nothing was applied — a group applies all or nothing`,
    );
  }
  if (edits.length === 0) {
    throw new AmbiguityError(`group "${groupId}" has no applyable suggestions`);
  }
  return { content: applyRangedEdits(content, edits), applied: edits.length, skipped };
}

/** Accept (keep replacement) or reject (keep span) the SUGGEST matched by `phrase`. */
export function resolveSuggestion(content: string, phrase: string, mode: "accept" | "reject"): string {
  const c = findSuggestionComment(content, phrase);
  const edit = suggestionThreadEdit(content, c, mode);
  if (!edit) {
    const repl = suggestionReplacement(c.body);
    if (mode === "accept" && repl !== null && unsafeSuggestion(content, c)) {
      throw new AmbiguityError(
        `"${phrase.slice(0, 48)}": its replacement contains CriticMarkup delimiters, so accepting it would break the markup`,
      );
    }
    throw new AmbiguityError(`"${phrase.slice(0, 48)}" is not an anchored suggestion`);
  }
  return applyEdit(content, edit);
}

/** Strip the whole thread matched by `phrase` (anchor + all comments), keeping the
 *  span prose. */
export function resolveThread(content: string, phrase: string): string {
  const th = findThread(content, phrase);
  return applyEdit(content, resolveAnchorEdit(content, th.from, th.to));
}

export interface ThreadSummary {
  id: string;
  from: number;
  to: number;
  anchor: string | null; // the highlighted span this thread is about, if any
  authors: string[];
  count: number; // messages in the thread
  applicable: boolean; // has an applyable SUGGEST
  seen: boolean | null; // human read every comment (GUI "seen"); null = no seen state (suggestion-attached)
  editRequested: boolean; // the human asked for an edit ("please suggest an edit") with no SUGGEST since
  preview: string; // first comment, trimmed
}

/** Read/verify surface: every thread with its anchor span, authors, count, and
 *  whether it carries an applyable suggestion. Drives `acm threads [--json]`.
 *  `seenKeys` is the human's persisted per-document seen-set (content keys via
 *  commentKey, from ~/.config/acm/settings.json); a thread counts as seen only when EVERY
 *  comment in it is — the same rule the GUI uses. Threads whose comments ride a
 *  raw `{++/--/~~}` suggestion card have NO seen affordance in the GUI (they're
 *  accept/reject, not inbox items) → `seen: null`, so the unseen count can't
 *  drift from the GUI's counter. */
export function threadsSummary(content: string, seenKeys: Set<string> = new Set()): ThreadSummary[] {
  const tokens = scanTokens(content);
  const comments = tokens.filter((t): t is CommentToken => t.type === "comment");
  const applicable = applicableSuggestionIds(content, tokens);
  // Comments claimed by a raw-suggestion card (adjacent to a `{++/--/~~}` token) —
  // the GUI gives these no Mark-seen toggle and keeps them out of the inbox count.
  const suggestionComments = new Set(
    groupCards(tokens, content)
      .filter((c) => c.kind === "suggestion")
      .flatMap((c) => c.comments.map((cm) => cm.id)),
  );
  return groupThreads(comments, content).map((th) => {
    // Same gap-tolerant adjacency rule as the sidebar/apply path — a stray space
    // between span and comment must not report `anchor: null` on an applyable
    // suggestion (they previously disagreed: strict equality here, ANCHOR_GAP there).
    const hl = anchorHighlightFor(content, th.comments[0], tokens);
    return {
      id: th.id,
      from: th.from,
      to: th.to,
      anchor: hl && hl.type === "highlight" ? hl.inner : null,
      authors: [...new Set(th.comments.map((c) => c.author ?? "?"))],
      count: th.comments.length,
      applicable: th.comments.some((c) => applicable.has(c.id)),
      seen: th.comments.some((c) => suggestionComments.has(c.id))
        ? null
        : th.comments.every((c) => seenKeys.has(commentKey(c))),
      editRequested: threadEditRequested(th),
      preview: (th.comments[0]?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    };
  });
}

/** A warning for `acm suggest` when the span or the replacement starts or ends with
 *  whitespace, or null. Apply swaps the span for the replacement byte for byte, so
 *  a boundary space on one side and not the other glues or splits words (#75). */
export function suggestionWhitespaceWarning(span: string, replacement: string): string | null {
  const parts: string[] = [];
  if (/^\s/.test(span)) parts.push("the span starts with whitespace");
  if (/\s$/.test(span)) parts.push("the span ends with whitespace");
  if (/^\s/.test(replacement)) parts.push("the replacement starts with whitespace");
  if (/\s$/.test(replacement)) parts.push("the replacement ends with whitespace");
  if (parts.length === 0) return null;
  return `${parts.join(" and ")} — Apply replaces the span's whitespace with the replacement's, exactly as written; check the words on either side still read right`;
}
