// ── Derived document state (pure memos over the doc string) ───────────────────
// Everything the sidebar/nav/pill read is derived here from `doc` (the React
// mirror of the editor buffer) in one place: tokens → threads/cards → the
// inline-suggestion list and its gates → markup health. One hook so the
// derivation chain is readable top-to-bottom and the Workspace stays wiring.

import { useMemo } from "react";
import {
  scanTokens,
  countWords,
  groupThreads,
  groupCards,
  suggestCards,
  suggestionGroupMembers,
  nestedCommentIssues,
  validateMarkup,
  healDocument,
} from "../lib/criticmarkup";
import type { SuggestionGroupMember } from "../lib/criticmarkup";
import { isComment } from "../lib/types";
import type { SidebarCard } from "../lib/types";
import { commentKey } from "./useConfigState";

export function useDocDerived(doc: string) {
  const tokens = useMemo(() => scanTokens(doc), [doc]);
  const wordCount = useMemo(() => countWords(doc), [doc]);
  // Markdown headings → the floating outline (TOC). Strip any inline CriticMarkup
  // from the displayed text; `from` is the heading line's doc offset (jump target).
  const headings = useMemo(() => {
    const out: { level: number; text: string; from: number }[] = [];
    // A `# heading` line living INSIDE a multi-line CriticMarkup add/del/sub block is
    // tracked-change content, not a document heading — keep it out of the outline.
    const markupSpans = tokens.filter(
      (t) => t.type === "insert" || t.type === "delete" || t.type === "substitute",
    );
    const insideMarkup = (i: number) => markupSpans.some((t) => i >= t.from && i < t.to);
    const re = /^(#{1,6})[ \t]+(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(doc)) !== null) {
      if (insideMarkup(m.index)) continue;
      const text = m[2]
        .replace(/\{>>[\s\S]*?<<\}/g, "")
        .replace(/\{(\+\+|--|~~|==)|(\+\+|--|~~|==)\}|~>/g, "")
        .trim();
      out.push({ level: m[1].length, text, from: m.index });
    }
    return out;
  }, [doc, tokens]);
  const comments = useMemo(() => tokens.filter(isComment), [tokens]);
  // Adjacent comments grouped into threaded cards (root + replies).
  const threads = useMemo(() => groupThreads(comments, doc), [comments, doc]);
  // The full margin set: comment threads + suggestion cards (with adjacent replies),
  // ordered by offset. Drives the sidebar.
  const cards = useMemo(() => groupCards(tokens, doc), [tokens, doc]);
  // Comment-kind cards only — for seen/unseen accounting (suggestions are accept/
  // reject, not "seen", and shouldn't inflate the inbox).
  const commentCards = useMemo(() => cards.filter((c) => c.kind === "comment"), [cards]);
  // The anchored SUGGEST: pairs — ONE pass over the already-memoized tokens, feeding
  // both the editor's inline accept/reject layer and the sidebar's Apply gate. The
  // gate is just their ids, so "what's applyable" can't drift between the two.
  const suggestCardList = useMemo(() => suggestCards(doc, tokens), [doc, tokens]);
  const applicableSuggestionIds = useMemo(
    () => new Set(suggestCardList.map((s) => s.commentId)),
    [suggestCardList],
  );

  // Doc health: comments accidentally inserted INSIDE another comment's body
  // (nested `{>>…{>>…<<}…<<}`) — they render raw and split words. Each is
  // auto-healable (pull the inner one out into an adjacent comment).
  const healIssues = useMemo(() => nestedCommentIssues(doc), [doc]);
  // ALL markup defects — every delimiter that renders raw (leaking highlights,
  // dangling opens, stray closes, malformed comments), as positioned diagnostics
  // (#18) — plus how many of those one click can repair (simulate the full heal,
  // diff the counts). ONE memo so a defect-carrying doc pays the heal+validate
  // simulation once per doc change, not once per derived value.
  const { diagnostics, fixableCount } = useMemo(() => {
    const diags = validateMarkup(doc);
    if (diags.length === 0) return { diagnostics: diags, fixableCount: 0 };
    return { diagnostics: diags, fixableCount: diags.length - validateMarkup(healDocument(doc)).length };
  }, [doc]);


  // commentId → its suggestion group (id + member count), for the sidebar's
  // group-wide Apply/Reject controls. Only real groups (≥2 members) qualify.
  const suggestionGroupOf = useMemo(() => {
    const map = new Map<string, { id: string; size: number }>();
    for (const s of suggestCardList) {
      if (s.groupId && s.groupSize > 1) map.set(s.commentId, { id: s.groupId, size: s.groupSize });
    }
    return map;
  }, [suggestCardList]);

  // groupId → its members, flattened to {old span, new wording} pairs in document
  // order — the data every "see the whole group together" view (popover / inline /
  // panel) renders before an Apply-all. Built once per doc change from the same
  // inline-suggestion pass, so the preview can't drift from what Apply-all does.
  const groupMembersOf = useMemo(() => {
    const map = new Map<string, SuggestionGroupMember[]>();
    const ids = new Set<string>();
    for (const s of suggestCardList) if (s.groupId && s.groupSize > 1) ids.add(s.groupId);
    for (const id of ids) map.set(id, suggestionGroupMembers(doc, id, tokens));
    return map;
  }, [suggestCardList, doc, tokens]);

  return {
    tokens,
    wordCount,
    headings,
    comments,
    threads,
    cards,
    commentCards,
    suggestCardList,
    applicableSuggestionIds,
    healIssues,
    diagnostics,
    fixableCount,
    suggestionGroupOf,
    groupMembersOf,
  };
}

/** Seen/unseen accounting over the comment cards (zero-inbox counters). */
export function useSeenDerived(commentCards: SidebarCard[], seen: Set<string>) {
  const seenThreadIds = useMemo(
    () =>
      new Set(
        commentCards.filter((t) => t.comments.every((c) => seen.has(commentKey(c)))).map((t) => t.id),
      ),
    [commentCards, seen],
  );
  // Unseen comment threads remaining (drives the zero-inbox counter).
  const unseenCount = useMemo(
    () => commentCards.filter((t) => !t.comments.every((c) => seen.has(commentKey(c)))).length,
    [commentCards, seen],
  );
  return { seenThreadIds, unseenCount };
}
