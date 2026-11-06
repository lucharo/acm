// ── Grouped notes (#77) and edit requests (#76) ──────────────────────────────
// Both are conventions INSIDE a comment body, like `SUGGEST[g:id]:` (ADR 0003), so
// the file stays plain CriticMarkup and an older ACM shows them as ordinary text.
//
//   NOTE[g:facts]: Source: the 2024 annual report.   a plain note in group "facts"
//   please suggest an edit                            a request for an agent's SUGGEST

import {
  anchorHighlightFor,
  groupThreads,
  isEditRequestBody,
  resolveAnchorEdit,
  scanTokens,
  suggestionReplacement,
} from "./criticmarkup";
import type { CommentThread, CommentToken, CritToken } from "./types";

// Same id grammar as SUGGEST[g:id]; exactly one optional space after the colon,
// everything after it is the note.
const NOTE_PREFIX = /^\s*NOTE\[g:([^\]\s]+)\]: ?([\s\S]*)$/;

/** The group a plain note belongs to (`NOTE[g:facts]: …` → "facts"), else null. */
export function noteGroupId(body: string): string | null {
  return body.match(NOTE_PREFIX)?.[1] ?? null;
}

/** A note's text without its group tag; any other body is returned unchanged. */
export function noteText(body: string): string {
  const m = body.match(NOTE_PREFIX);
  return m ? m[2] : body;
}

/** Re-attach a note's group tag after its text was edited. */
export function withNoteGroup(groupId: string | null, text: string): string {
  return groupId ? `NOTE[g:${groupId}]: ${text}` : text;
}

/** A review group as one card sees it: its id and how many edits and notes share it. */
export interface ReviewGroupInfo {
  id: string;
  edits: number;
  notes: number;
}

/** One grouped note, flattened for the group surface: the thread it opens (Resolve
 *  all strips it) and the span it is about (the row's jump target). */
export interface GroupNoteMember {
  commentId: string;
  threadId: string;
  threadFrom: number;
  threadTo: number;
  anchorFrom: number;
  anchorTo: number;
  anchorText: string | null; // null → a point note with no highlighted span
  author: string | null;
  text: string;
}

/** groupId → its notes in document order. A thread counts once per group, at its
 *  first tagged comment. */
export function noteGroupMembers(
  content: string,
  tokens: CritToken[] = scanTokens(content),
  threads?: CommentThread[],
): Map<string, GroupNoteMember[]> {
  const comments = tokens.filter((t): t is CommentToken => t.type === "comment");
  const allThreads = threads ?? groupThreads(comments, content);
  const out = new Map<string, GroupNoteMember[]>();
  for (const thread of [...allThreads].sort((a, b) => a.from - b.from)) {
    const seen = new Set<string>();
    for (const comment of thread.comments) {
      const groupId = noteGroupId(comment.body);
      if (!groupId || seen.has(groupId)) continue;
      seen.add(groupId);
      const hl = anchorHighlightFor(content, thread.comments[0], tokens);
      const anchored = hl?.type === "highlight" ? hl : null;
      const list = out.get(groupId) ?? [];
      list.push({
        commentId: comment.id,
        threadId: thread.id,
        threadFrom: thread.from,
        threadTo: thread.to,
        anchorFrom: anchored ? anchored.from + 3 : thread.from,
        anchorTo: anchored ? anchored.to - 3 : thread.to,
        anchorText: anchored ? anchored.inner : null,
        author: comment.author,
        text: noteText(comment.body),
      });
      out.set(groupId, list);
    }
  }
  return out;
}

/** Resolve every note thread of `groupId` as one batch of ranged edits in original
 *  coordinates (one transaction, one undo). `threads` are the resolved threads, for
 *  the decision log. A thread whose resolve range overlaps an earlier one is left
 *  open and counted in `skipped`. */
export function noteGroupResolveEdits(
  content: string,
  groupId: string,
): {
  edits: { from: number; to: number; insert: string }[];
  threads: CommentThread[];
  skipped: number;
} {
  const tokens = scanTokens(content);
  const comments = tokens.filter((t): t is CommentToken => t.type === "comment");
  const threads = groupThreads(comments, content);
  const members = noteGroupMembers(content, tokens, threads).get(groupId) ?? [];
  const planned = members
    .map((m) => {
      const thread = threads.find((t) => t.id === m.threadId)!;
      return { thread, edit: resolveAnchorEdit(content, thread.from, thread.to) };
    })
    .sort((a, b) => a.edit.from - b.edit.from);
  const kept: typeof planned = [];
  let skipped = 0;
  for (const p of planned) {
    const prev = kept[kept.length - 1];
    if (prev && p.edit.from < prev.edit.to) skipped += 1;
    else kept.push(p);
  }
  return { edits: kept.map((p) => p.edit), threads: kept.map((p) => p.thread), skipped };
}

// ── Edit requests (#76) ───────────────────────────────────────────────────────

export { EDIT_REQUEST_TEXT } from "./criticmarkup";

/** A thread is waiting on an agent's edit when it holds an edit request with no
 *  SUGGEST after it. A SUGGEST answers the request; a later request re-opens it. */
export function threadEditRequested(thread: Pick<CommentThread, "comments">): boolean {
  let waiting = false;
  for (const comment of thread.comments) {
    if (suggestionReplacement(comment.body) !== null) waiting = false;
    else if (isEditRequestBody(comment.body)) waiting = true;
  }
  return waiting;
}
