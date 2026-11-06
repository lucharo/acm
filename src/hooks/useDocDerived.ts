// ── Derived document state (pure memos over the doc string) ───────────────────
// Everything the review surfaces read is derived here from `doc` (the React
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
  commentKey,
  anchorHighlightFor,
} from "../lib/criticmarkup";
import type { SuggestionGroupMember } from "../lib/criticmarkup";
import { isComment } from "../lib/types";
import { noteGroupMembers } from "../lib/commentGroups";
import type { ReviewGroupInfo } from "../lib/commentGroups";
import type { SidebarCard } from "../lib/types";

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


  // Comment cards anchored to a highlighted span: the only threads where a SUGGEST
  // reply can apply, so the only ones that offer Ask agent (#76).
  const anchoredCardIds = useMemo(
    () =>
      new Set(
        cards
          .filter((card) => card.kind === "comment" && card.comments[0])
          .filter((card) => anchorHighlightFor(doc, card.comments[0], tokens)?.type === "highlight")
          .map((card) => card.id),
      ),
    [cards, doc, tokens],
  );

  // Review groups: SUGGEST[g:id] edits (#21) and NOTE[g:id] notes (#77) sharing an
  // id. Only real groups (≥2 members in total) get the group surface.
  const noteMembersOf = useMemo(() => noteGroupMembers(doc, tokens, threads), [doc, tokens, threads]);
  const realGroupIds = useMemo(() => {
    const counts = new Map<string, { edits: number; notes: number }>();
    const bump = (id: string, key: "edits" | "notes", by: number) => {
      const c = counts.get(id) ?? { edits: 0, notes: 0 };
      c[key] += by;
      counts.set(id, c);
    };
    for (const s of suggestCardList) if (s.groupId) bump(s.groupId, "edits", 1);
    for (const [id, notes] of noteMembersOf) bump(id, "notes", notes.length);
    return new Map([...counts].filter(([, c]) => c.edits + c.notes > 1));
  }, [suggestCardList, noteMembersOf]);

  // commentId → its review group, for the card spine and the group controls.
  const groupOf = useMemo(() => {
    const map = new Map<string, ReviewGroupInfo>();
    const info = (id: string) => ({ id, ...realGroupIds.get(id)! });
    for (const s of suggestCardList) {
      if (s.groupId && realGroupIds.has(s.groupId)) map.set(s.commentId, info(s.groupId));
    }
    for (const [id, notes] of noteMembersOf) {
      if (!realGroupIds.has(id)) continue;
      for (const n of notes) map.set(n.commentId, info(id));
    }
    return map;
  }, [suggestCardList, noteMembersOf, realGroupIds]);

  // groupId → its edits, flattened to {old span, new wording} pairs in document
  // order — what the group surface lists before an Apply-all. Built from the same
  // inline-suggestion pass, so the preview can't drift from what Apply-all does.
  const groupMembersOf = useMemo(() => {
    const map = new Map<string, SuggestionGroupMember[]>();
    for (const [id, c] of realGroupIds) if (c.edits > 0) map.set(id, suggestionGroupMembers(doc, id, tokens));
    return map;
  }, [realGroupIds, doc, tokens]);

  // groupId → its notes, for the group surface's note rows and Resolve all.
  const groupNotesOf = useMemo(
    () => new Map([...noteMembersOf].filter(([id]) => realGroupIds.has(id))),
    [noteMembersOf, realGroupIds],
  );

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
    groupOf,
    groupMembersOf,
    groupNotesOf,
    anchoredCardIds,
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
