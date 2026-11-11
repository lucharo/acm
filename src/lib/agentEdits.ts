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
  validateMarkup,
  inLiteral,
} from "./criticmarkup";
import { textChangeHunks } from "./merge";
import type { CommentToken, CommentThread, MarkupDiagnosticKind } from "./criticmarkup";
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
  lastAuthor: string; // who wrote the thread's latest comment
  awaitingAgent: boolean; // the person (the editor's author name) has the last word: the agent's turn (#31)
  preview: string; // first comment, trimmed
}

/** Read/verify surface: every thread with its anchor span, authors, count, and
 *  whether it carries an applyable suggestion. Drives `acm threads [--json]`.
 *  `seenKeys` is the human's persisted per-document seen-set (content keys via
 *  commentKey, from ~/.config/acm/settings.json); a thread counts as seen only when EVERY
 *  comment in it is — the same rule the GUI uses. Threads whose comments ride a
 *  raw `{++/--/~~}` suggestion card have NO seen affordance in the GUI (they're
 *  accept/reject, not inbox items) → `seen: null`, so the unseen count can't
 *  drift from the GUI's counter. `humanAuthor` is the person's name (the editor's
 *  `author` setting): a thread whose latest comment is theirs is the agent's turn. */
export function threadsSummary(
  content: string,
  seenKeys: Set<string> = new Set(),
  humanAuthor = "You",
): ThreadSummary[] {
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
    const lastAuthor = th.comments[th.comments.length - 1]?.author ?? "?";
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
      lastAuthor,
      awaitingAgent: lastAuthor === humanAuthor,
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

const SUGGEST_KINDS = new Set<MarkupDiagnosticKind>(["orphan-suggestion", "unsafe-suggestion", "mixed-suggestion"]);
// A body that opens with its own `@name:` envelope: acm writes the author prefix,
// so an agent that types it as well hides whatever follows behind a second one.
// Up to the first colon, as the comment parser reads an author (names can have spaces).
const LEADING_AUTHOR = /^@([^:\r\n]+):[ \t]*/;

/** One problem a write introduced (#27): markup the editor's "Review comments that
 *  can't display or apply" panel flags, or a comment that repeats its author prefix. */
export interface WriteProblem {
  line: number; // 1-based
  threadId: string | null; // the thread's id as `acm threads` prints it; null when not in a comment
  commentId: string | null;
  anchor: string | null; // the span the thread is anchored on; null for a point comment
  preview: string; // the comment's text, or the line's, shortened
  suggestion: boolean; // a SUGGEST that won't apply
  reason: string;
  key: string; // offset-free identity: the comment's raw bytes, else kind + line text
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Take one `key` from a multiset; false when none is left. */
function take(counts: Map<string, number>, key: string): boolean {
  const n = counts.get(key) ?? 0;
  if (n === 0) return false;
  counts.set(key, n - 1);
  return true;
}

function commentsOf(text: string): CommentToken[] {
  return scanTokens(text).filter((t): t is CommentToken => t.type === "comment");
}

/** The raw bytes of every comment `after` has that `before` did not. */
export function addedCommentRaws(before: string, after: string): Set<string> {
  const old = new Map<string, number>();
  for (const c of commentsOf(before)) bump(old, c.raw);
  return new Set(commentsOf(after).filter((c) => !take(old, c.raw)).map((c) => c.raw));
}

/**
 * The problems `after` has that `before` did not: what one write added, never what
 * the document already carried (#27). A problem in a comment is matched by the
 * comment's bytes, so a batch that touches several threads still recognises the
 * old ones; any other problem is matched by position, mapped across each changed
 * range of the write.
 */
export function writeProblems(before: string, after: string): WriteProblem[] {
  const hunks = textChangeHunks(before, after);
  /** Where offset `at` of `after` sat in `before`, or the changed range it is in. */
  const mapBack = (at: number): { was: number } | { hunk: number } => {
    let shift = 0;
    for (const [i, h] of hunks.entries()) {
      if (at < h.afterFrom) break;
      if (at < h.afterTo) return { hunk: i };
      shift += h.afterTo - h.afterFrom - (h.beforeTo - h.beforeFrom);
    }
    return { was: at - shift };
  };

  const oldComments = commentsOf(before);
  const oldCommentAt = new Map(oldComments.map((c) => [c.from, c]));
  // A code example is text, so it can't stand in for a comment the write added.
  const oldRaws = new Map<string, number>();
  for (const c of oldComments) if (!inLiteral(before, c.from)) bump(oldRaws, c.raw);
  const oldInComment = new Map<string, number>();
  const oldElsewhere = new Set<string>();
  // An old problem inside a changed range has no position to match; a rewrite of
  // that range (wrap, heal) keeps it, so it is matched by kind and count per range.
  const oldInChange = new Map<string, number>();
  for (const d of validateMarkup(before)) {
    const c = oldCommentAt.get(d.from);
    const hunk = hunks.findIndex((h) => d.from >= h.beforeFrom && d.from < h.beforeTo);
    if (c) bump(oldInComment, `${d.kind}\u0000${c.raw}`);
    else if (hunk >= 0) bump(oldInChange, `${hunk}\u0000${d.kind}`);
    else oldElsewhere.add(`${d.kind}@${d.from}`);
  }

  const tokens = scanTokens(after);
  const comments = tokens.filter((t): t is CommentToken => t.type === "comment");
  const commentAt = new Map(comments.map((c) => [c.from, c]));
  const threadOf = new Map(groupThreads(comments, after).flatMap((th) => th.comments.map((c) => [c, th] as const)));
  const lineAt = (at: number) => after.slice(0, at).split("\n").length;

  const found = new Map<CommentToken, { suggestion: boolean; reasons: string[] }>();
  const note = (c: CommentToken, suggestion: boolean, reason: string) => {
    const entry = found.get(c) ?? { suggestion: false, reasons: [] };
    entry.suggestion ||= suggestion;
    entry.reasons.push(reason);
    found.set(c, entry);
  };

  // A doubled `@author:` prefix, on the comments this write added.
  const hidden = new Set<CommentToken>();
  for (const c of comments) {
    if (inLiteral(after, c.from) || take(oldRaws, c.raw)) continue;
    const m = c.body.match(LEADING_AUTHOR);
    if (!m) continue;
    const name = m[1].trim();
    const own = name === c.author;
    const lead = `its text starts with "@${name}:"${own ? ", which acm already writes as the author," : ","}`;
    if (suggestionReplacement(c.body.slice(m[0].length)) !== null) {
      hidden.add(c);
      note(c, true, `${lead} so the SUGGEST: behind it is hidden and it shows as a plain note with no Apply — start the text with "SUGGEST:"`);
    } else if (own) {
      note(c, false, `${lead} so it reads "@${name}: @${name}: …" — drop the prefix from the text`);
    }
  }

  const elsewhere: WriteProblem[] = [];
  for (const d of validateMarkup(after)) {
    const c = commentAt.get(d.from);
    if (c) {
      if (take(oldInComment, `${d.kind}\u0000${c.raw}`)) continue;
      if (d.kind === "mixed-suggestion" && hidden.has(c)) continue; // the prefix reason says why
      const thread = threadOf.get(c);
      const reply = thread !== undefined && thread.comments[0] !== c;
      note(
        c,
        SUGGEST_KINDS.has(d.kind),
        d.kind === "orphan-suggestion" && reply
          ? 'the thread it joins has no {==span==}, so this SUGGEST has nothing to apply to — anchor it with `acm suggest "<span>" "<new wording>"` instead'
          : d.message,
      );
      continue;
    }
    const at = mapBack(d.from);
    if ("hunk" in at ? take(oldInChange, `${at.hunk}\u0000${d.kind}`) : oldElsewhere.has(`${d.kind}@${at.was}`)) continue;
    const lineStart = after.lastIndexOf("\n", d.from - 1) + 1;
    const lineEnd = after.indexOf("\n", d.from);
    const preview = shorten(after.slice(lineStart, lineEnd < 0 ? after.length : lineEnd), 80);
    elsewhere.push({
      line: lineAt(d.from),
      threadId: null,
      commentId: null,
      anchor: null,
      preview,
      suggestion: false,
      reason: d.message,
      key: `${d.kind}\u0000${preview}`,
    });
  }

  const inComments: WriteProblem[] = [...found].map(([c, { suggestion, reasons }]) => {
    const thread = threadOf.get(c);
    const root = thread?.comments[0] ?? c;
    const hl = anchorHighlightFor(after, root, tokens);
    const reason = reasons.join("; ");
    return {
      line: lineAt(c.from),
      threadId: thread?.id ?? c.id,
      commentId: c.id,
      anchor: hl?.type === "highlight" ? shorten(hl.inner, 40) : null,
      preview: shorten(c.body, 80),
      suggestion,
      reason,
      key: c.raw,
    };
  });
  return [...inComments, ...elsewhere].sort((a, b) => a.line - b.line);
}
