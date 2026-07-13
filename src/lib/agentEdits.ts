// ── Agent edit verbs (pure core) ───────────────────────────────────────────────
// The logic behind the `acm` CLI verbs, kept I/O-free so it's unit-testable: each
// function takes the document text + args and returns the new text (or a summary),
// throwing on an ambiguous/missing target. Anchoring is by UNIQUE TEXT MATCH (not
// raw offsets) so it survives edits and fails safe — nothing applies unless exactly
// one thread/span matches. The CLI layer adds read → snapshot → write → verify.

import {
  scanTokens,
  groupThreads,
  commentKey,
  formatComment,
  suggestionThreadEdit,
  resolveAnchorEdit,
  suggestionReplacement,
  applicableSuggestionIds,
  anchorHighlightFor,
  wrappableSpan,
  suggestionGroupEdits,
  applyRangedEdits,
} from "./criticmarkup";
import type { CommentToken, CommentThread } from "./criticmarkup";

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

/** The single SUGGEST: comment whose body contains `phrase` (matches the proposed
 *  wording or the SUGGEST text). Throws unless exactly one matches. */
function findSuggestionComment(content: string, phrase: string): CommentToken {
  const hits = scanTokens(content).filter(
    (t): t is CommentToken =>
      t.type === "comment" && suggestionReplacement(t.body) !== null && t.body.includes(phrase),
  );
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
 *  matched by `phrase`, so it threads + inherits the anchor. Idempotent: if the
 *  exact marker is already in the document, returns it unchanged. */
export function appendToThread(content: string, phrase: string, marker: string): { content: string; skipped: boolean } {
  if (content.includes(marker)) return { content, skipped: true };
  const th = findThread(content, phrase);
  const pos = Math.max(...th.comments.map((c) => c.to)); // thread end
  return { content: content.slice(0, pos) + marker + content.slice(pos), skipped: false };
}

/** Reply to the thread matched by `phrase` with a plain comment by `author`. */
export function addComment(content: string, phrase: string, author: string, text: string): string {
  return appendToThread(content, phrase, formatComment(author, text)).content;
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
  const at = uniqueProseIndex(content, span);
  const prefix = group ? `SUGGEST[g:${group}]: ` : "SUGGEST: ";
  const marker = `{==${span}==}` + formatComment(author, prefix + replacement);
  return content.slice(0, at) + marker + content.slice(at + span.length);
}

/** Accept or reject EVERY member of suggestion group `groupId` in one write.
 *  Throws when the group has no applyable members. Members that can't resolve
 *  (or would contradict an earlier member on the same thread) are skipped. */
export function resolveSuggestionGroup(
  content: string,
  groupId: string,
  mode: "accept" | "reject",
): { content: string; applied: number; skipped: number } {
  const { edits, skipped } = suggestionGroupEdits(content, groupId, mode);
  if (edits.length === 0) {
    throw new AmbiguityError(`group "${groupId}" has no applyable suggestions`);
  }
  return { content: applyRangedEdits(content, edits), applied: edits.length, skipped };
}

/** Accept (keep replacement) or reject (keep span) the SUGGEST matched by `phrase`. */
export function resolveSuggestion(content: string, phrase: string, mode: "accept" | "reject"): string {
  const c = findSuggestionComment(content, phrase);
  const edit = suggestionThreadEdit(content, c, mode);
  if (!edit) throw new AmbiguityError(`"${phrase.slice(0, 48)}" is not an anchored suggestion`);
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
  seen: boolean; // the human has read every comment in the thread (GUI "seen" state)
  preview: string; // first comment, trimmed
}

/** Read/verify surface: every thread with its anchor span, authors, count, and
 *  whether it carries an applyable suggestion. Drives `acm threads [--json]`.
 *  `seenKeys` is the human's persisted seen-set (content keys via commentKey,
 *  from ~/.config/acm/settings.json); a thread counts as seen only when EVERY
 *  comment in it is — the same rule the GUI uses. */
export function threadsSummary(content: string, seenKeys: Set<string> = new Set()): ThreadSummary[] {
  const tokens = scanTokens(content);
  const comments = tokens.filter((t): t is CommentToken => t.type === "comment");
  const applicable = applicableSuggestionIds(content, tokens);
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
      seen: th.comments.every((c) => seenKeys.has(commentKey(c))),
      preview: (th.comments[0]?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    };
  });
}
