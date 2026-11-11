// Right-margin comment column — Google-Docs style, threaded, and SMOOTH on scroll.
//
// Smoothness: split position into a stable DOCUMENT-space layout (recomputed
// rarely) and a cheap per-frame TRANSFORM. Each thread's anchor Y comes from
// view.lineBlockAt(from).top (document space, valid off-viewport). Cards + the
// active connector live in layers that are moved by one imperative
// translate3d(0,-scrollTop,0) per scroll frame — no React/measure on scroll, so
// they track the text in lockstep. Recompute only on doc/resize/scroll-settle.
//
// Connector: only the ACTIVE thread draws one, and it runs from the PAGE's right
// edge (contentDOM right) across the gutter to the card — so it's visible even
// with the page-view desk. It lives in an overflow-visible layer (can extend left
// over the gutter); the cards live in a separate clipped layer (so off-screen
// cards don't spill over the header).
//
// Threads: comments sharing an anchor render as one card (root + replies).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import { MOD } from "../lib/platform";
import type { SidebarCard, CommentToken, SuggestionToken } from "../lib/types";
import { suggestionReplacement } from "../lib/criticmarkup";
import type { SuggestionGroupMember } from "../lib/criticmarkup";
import { commentStatusOccluded, innerScrollerTakesWheel, stepReviewCard } from "../lib/commentRail";
import type { WheelBox } from "../lib/commentRail";
import { EDIT_REQUEST_TEXT, noteGroupId, noteText, threadEditRequested, withNoteGroup } from "../lib/commentGroups";
import type { GroupNoteMember, ReviewGroupInfo } from "../lib/commentGroups";
import { commentSegments } from "../lib/commentLinks";
import { visibleReviewCards } from "../lib/visibleReviewCards";
import { authorColor, groupColor } from "./authorColor";
import CommentComposer from "./CommentComposer";
import { handleCommentKey, mayDiscardDraft } from "./commentKeys";
import ReviewTextEditor, { closeReviewEditorAfterSuccessfulSave } from "./ReviewTextEditor";

interface CommentSidebarProps {
  view: EditorView | null;
  /** Comment threads AND suggestions, as one ordered set (see groupCards). */
  cards: SidebarCard[];
  /** Whether standalone additions are already rendered as rich document blocks. */
  richPreview: boolean;
  activeId: string | null;
  /** Comment-card ids whose every comment is marked "seen" (suggestions never here). */
  seenIds: Set<string>;
  /** Reveal seen threads (dimmed). When false, seen threads are hidden entirely. */
  showSeen: boolean;
  /** Unseen comment threads remaining — drives the zero-inbox counter. */
  unseenCount: number;
  onToggleSeen: (card: SidebarCard) => void;
  repositionKey: number;
  /** Nonce-tagged request (from a right-click "Reply") to open a card's reply box. */
  replyTarget?: { id: string; n: number } | null;
  onResolveThread: (card: SidebarCard) => void;
  /** Delete a single comment (vs. resolving the whole thread). */
  onDeleteComment: (comment: CommentToken) => void;
  /** Edit one comment body while preserving its original Author. */
  onEditComment: (comment: CommentToken, body: string) => boolean;
  /** Edit the proposed wording of a SUGGEST card or native Suggestion. */
  onEditSuggestion: (suggestion: CommentToken | SuggestionToken, proposal: string) => boolean;
  onReply: (card: SidebarCard, text: string) => void;
  /** Reply AND mark the whole thread seen (dismiss it + advance) — ⌘⇧↵. */
  onReplyAndSeen: (card: SidebarCard, text: string) => void;
  /** Post a structured replacement proposal on this anchored discussion. */
  onSuggestEdit: (card: SidebarCard, proposal: string) => void;
  /** One click: append an edit request for the agent at the end of the thread and
   *  mark it seen (#76). */
  onAskAgent: (card: SidebarCard) => void;
  /** Agent wake control (#31) under the open-count, and one for the composer. */
  agentControl?: ReactNode;
  composerAgentControl?: ReactNode;
  /** Comment cards anchored to a highlighted span; only these offer Ask agent, as a
   *  SUGGEST reply on a point comment has no span to apply to. */
  anchoredCardIds?: Set<string>;
  /** Apply a structured `SUGGEST:` comment — replace its anchored span with the
   *  proposed wording. */
  onApplySuggestion: (comment: CommentToken) => void;
  /** Apply the wording and close its complete discussion as one undoable action. */
  onApplyAndResolveSuggestion: (comment: CommentToken) => void;
  /** Reject a structured `SUGGEST:` comment — keep the original span (mirror of Apply). */
  onRejectSuggestionEdit: (comment: CommentToken) => void;
  /** Ids of SUGGEST: comments with a resolvable anchor → their Apply is real.
   *  A SUGGEST: not in this set shows the proposal but no (dead) Apply button. */
  applicableSuggestionIds: Set<string>;
  /** commentId → its review group (id + edit and note counts), for SUGGEST[g:id]
   *  edits (#21) and NOTE[g:id] notes (#77). Only real groups (≥2 members) appear. */
  groupOf: Map<string, ReviewGroupInfo>;
  /** groupId → its edits ({old span, new wording}, in document order) — the data
   *  the group surface lists so the whole set is reviewable before an Apply-all. */
  groupMembersOf: Map<string, SuggestionGroupMember[]>;
  /** groupId → its notes, in document order. */
  groupNotesOf: Map<string, GroupNoteMember[]>;
  /** Resolve a group's note threads as one atomic edit: every one, or all but
   *  the comment ids in `unticked` (#25). */
  onGroupResolveNotes: (groupId: string, unticked?: ReadonlySet<string>) => void;
  /** Accept/reject a group's members as one atomic edit: every member, or all
   *  but the comment ids in `unticked` (#25). */
  onGroupEdit: (groupId: string, mode: "accept" | "reject", unticked?: ReadonlySet<string>) => void;
  /** Apply every non-conflicting (ticked) member and resolve its discussion atomically. */
  onGroupApplyAndResolve: (groupId: string, unticked?: ReadonlySet<string>) => void;
  /** Scroll a span into view + flash it — a group member row → its edit in the doc. */
  onLocate: (from: number, to: number) => void;
  /** Accept / reject a suggestion card's suggestion. */
  onAcceptSuggestion: (card: SidebarCard) => void;
  onRejectSuggestion: (card: SidebarCard) => void;
  onFocusThread: (card: SidebarCard) => void;
  onCardContextMenu?: (card: SidebarCard, e: ReactMouseEvent) => void;
  /** New-comment composer, anchored beside the current editor selection. */
  composerOpen: boolean;
  composerKind: "comment" | "suggestion";
  composerDraft: string;
  composerAnchored: boolean;
  onComposerDraftChange: (value: string) => void;
  onPostComment: () => void;
  onPostCommentSeen: () => void;
  onCancelComposer: () => void;
  /** How far the lowest card sticks out BELOW the document's last line (px, ≥0).
   *  App applies it as extra scroller bottom padding so those cards stay
   *  scroll-reachable — without stretching the page sheet itself. */
  onContentExtent?: (px: number) => void;
}

const BUBBLE_GAP = 16;
const CARD_LEFT = 18; // px from the column's left edge to the card
const COMPOSER_ID = "__acm-comment-composer__";

// Re-exported so existing `import { MOD } from "./CommentSidebar"` callers keep
// working; the glyph itself now lives in lib/platform.
export { MOD };
export { handleCommentKey };

interface CardLayout {
  anchorY: number; // document-space Y of the anchored line
  cardY: number; // document-space Y of the card top (after greedy stacking)
}

function layoutsEqual(a: Map<string, CardLayout>, b: Map<string, CardLayout>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, la] of a) {
    const lb = b.get(id);
    if (!lb || Math.abs(la.cardY - lb.cardY) > 0.5 || Math.abs(la.anchorY - lb.anchorY) > 0.5) {
      return false;
    }
  }
  return true;
}

export function standaloneAdditionTitle(source: string): string {
  const firstLine = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "Untitled addition";
  const plain = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-+*]|\d+[.)])\s+/, "")
    .replace(/!?(?:\[([^\]]+)\])\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
  return plain || "Untitled addition";
}

export default function CommentSidebar(props: CommentSidebarProps) {
  const {
    view,
    cards,
    richPreview,
    activeId,
    seenIds,
    showSeen,
    unseenCount,
    onToggleSeen,
    repositionKey,
    replyTarget,
    onResolveThread,
    onDeleteComment,
    onEditComment,
    onEditSuggestion,
    onReply,
    onReplyAndSeen,
    onSuggestEdit,
    onAskAgent,
    agentControl,
    composerAgentControl,
    anchoredCardIds,
    onApplySuggestion,
    onApplyAndResolveSuggestion,
    groupOf,
    groupMembersOf,
    groupNotesOf,
    onGroupResolveNotes,
    onGroupEdit,
    onGroupApplyAndResolve,
    onLocate,
    onRejectSuggestionEdit,
    applicableSuggestionIds,
    onAcceptSuggestion,
    onRejectSuggestion,
    onFocusThread,
    onCardContextMenu,
    composerOpen,
    composerKind,
    composerDraft,
    composerAnchored,
    onComposerDraftChange,
    onPostComment,
    onPostCommentSeen,
    onCancelComposer,
    onContentExtent,
  } = props;

  // Smooth the "mark seen" hide: keep a just-seen card mounted for a short fade
  // (≈220ms) instead of yanking it from the DOM (which blinks). `exiting` holds the
  // ids mid-animation; they render with opacity 0 + a slight scale, then unmount.
  const [exiting, setExiting] = useState<Set<string>>(() => new Set());
  const prevSeenRef = useRef(seenIds);
  useEffect(() => {
    if (!showSeen) {
      const newly = [...seenIds].filter((id) => !prevSeenRef.current.has(id));
      if (newly.length) {
        setExiting((p) => new Set([...p, ...newly]));
        setTimeout(() => {
          setExiting((p) => {
            const n = new Set(p);
            for (const id of newly) n.delete(id);
            return n;
          });
        }, 220);
      }
    }
    prevSeenRef.current = seenIds;
  }, [seenIds, showSeen]);

  // Threads actually shown: seen ones are HIDDEN by default (zero-inbox), revealed
  // (dimmed) only when "Show seen" is on. Cards mid-exit-animation stay rendered so
  // they can fade. Used for BOTH layout and render so hidden cards take no space.
  const visibleCards = visibleReviewCards(cards, seenIds, showSeen, exiting);

  const composerFrom = composerOpen && view ? view.state.selection.main.to : 0;
  const layoutItems = [
    ...visibleCards.map((card) => ({ id: card.id, from: card.from })),
    ...(composerOpen ? [{ id: COMPOSER_ID, from: composerFrom }] : []),
  ];

  // Recompute the layout only when the STRUCTURE changes — the set of thread ids and
  // their anchor offsets — NOT on every keystroke. `threads` is a fresh array each
  // render (groupThreads rebuilds it), so depending on it re-measured constantly,
  // often against not-yet-settled editor geometry → the "all cards lift up" glitch.
  // `from` is included because typing ABOVE a comment legitimately shifts its anchor.
  const structureKey = layoutItems.map((item) => `${item.id}:${item.from}`).join("|");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const cardsTrackRef = useRef<HTMLDivElement | null>(null);
  const connTrackRef = useRef<SVGSVGElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const layoutRef = useRef<Map<string, CardLayout>>(new Map());
  const measureRetriesRef = useRef(0);
  const [layout, setLayout] = useState<Map<string, CardLayout>>(() => new Map());
  // X (sidebar-local) of the page's right edge — where connectors originate.
  // Negative when the page sits left of this column (the usual case).
  const [originX, setOriginX] = useState(0);

  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyMode, setReplyMode] = useState<"reply" | "suggestion">("reply");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // Which group CONTROL's "see the whole set" surface is open (popover / inline
  // expand), keyed by the member comment whose chip was clicked — so opening it on
  // one member card doesn't fan the popover out across every sibling card. One at a
  // time — opening another closes the last.
  // A large group opens as a side panel instead of the popover (#67).
  const [openControl, setOpenControl] = useState<{ key: string; mode: GroupSurfaceMode } | null>(null);
  // Click anywhere outside a group surface closes it (popover feel). The toggle +
  // popover carry data-group-ui so a click on them doesn't self-close.
  useEffect(() => {
    if (!openControl) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest("[data-group-ui]")) setOpenControl(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openControl]);

  // A right-click "Reply" elsewhere opens this thread's reply box (nonce re-fires
  // the effect even for the same thread).
  useEffect(() => {
    if (replyTarget) {
      setReplyingId(replyTarget.id);
      setReplyDraft("");
      setReplyMode("reply");
    }
  }, [replyTarget]);

  // Cheap per-frame: keep the layers aligned to the editor's scroll. No React.
  const syncTransform = () => {
    const v = view;
    if (!v) return;
    const scrollTop = v.scrollDOM.scrollTop;
    const t = `translate3d(0, ${-scrollTop}px, 0)`;
    if (cardsTrackRef.current) cardsTrackRef.current.style.transform = t;
    if (connTrackRef.current) connTrackRef.current.style.transform = t;
    if (statusRef.current) {
      const bounds = visibleCards.flatMap((card) => {
        const position = layoutRef.current.get(card.id);
        const element = cardRefs.current.get(card.id);
        if (!position || !element) return [];
        const top = position.cardY - scrollTop;
        return [{ top, bottom: top + element.offsetHeight }];
      });
      const hidden = commentStatusOccluded(bounds);
      statusRef.current.style.opacity = hidden ? "0" : "1";
      statusRef.current.style.pointerEvents = hidden ? "none" : "auto";
    }
  };

  // The scroll listener is installed once per view, but card visibility can
  // change without replacing that view. Keep its fast path pointed at the
  // latest card set instead of retaining the callback from the first render.
  const syncTransformRef = useRef(syncTransform);
  syncTransformRef.current = syncTransform;

  // Expensive but rare: document-space anchors + card heights, greedy-stack, commit.
  const recompute = () => {
    const v = view;
    const container = containerRef.current;
    if (!v || !container) return;
    v.requestMeasure({
      key: "acm-comment-sidebar",
      read(view0) {
        const cRect = container.getBoundingClientRect();
        // First-line origin in column coords, from the CONTENT element (+ scrollTop
        // to be scroll-stable) so any scroller/page padding is already accounted for.
        const contentRect = view0.contentDOM.getBoundingClientRect();
        // If the editor/container geometry isn't settled (height 0 — mid-mount, page
        // -view/font swap, hidden), a read now would collapse every anchorY toward
        // the top. Bail; WRITE keeps the last-good layout and retries next frame.
        if (contentRect.height === 0 || cRect.height === 0) return { valid: false as const };
        const padTop = view0.documentPadding.top;
        const docTop = contentRect.top + view0.scrollDOM.scrollTop - cRect.top + padTop;
        const measured = layoutItems.map((item) => {
          const tableMarker = view0.dom.querySelector<HTMLElement>(
            `[data-comment-from="${item.from}"]`,
          );
          const tableCell = tableMarker?.closest<HTMLElement>("th,td");
          const cellRect = tableCell?.getBoundingClientRect();
          return {
            id: item.id,
            anchorY: cellRect
              ? cellRect.top - cRect.top + view0.scrollDOM.scrollTop + Math.min(18, cellRect.height / 2)
              : docTop + view0.lineBlockAt(item.from).top,
            height: cardRefs.current.get(item.id)?.offsetHeight ?? 0,
          };
        });
        // Bottom of the LAST text line in column coords — the reference for how far
        // the card stack overflows the prose (independent of any applied spacer,
        // so there's no feedback loop with the padding this ultimately drives).
        const lastLineBottom = docTop + view0.lineBlockAt(view0.state.doc.length).bottom;
        return { valid: true as const, measured, origin: contentRect.right - cRect.left, lastLineBottom };
      },
      write(data) {
        if (!data.valid) {
          // Geometry wasn't ready (mid-mount, font/page-view swap) — retry after the
          // browser settles, WITHOUT clobbering the last-good layout (so cards never
          // jump to the top). Cap the retries: a hidden panel reads height 0 EVERY
          // frame, which would otherwise spin rAF at ~60Hz forever. Once it's shown
          // again the ResizeObserver re-fires recompute, so giving up here is safe.
          if (measureRetriesRef.current++ < 12) requestAnimationFrame(() => recomputeRef.current());
          return;
        }
        measureRetriesRef.current = 0;
        const { measured, origin, lastLineBottom } = data;
        const sorted = [...measured].sort((a, b) => a.anchorY - b.anchorY);
        const next = new Map<string, CardLayout>();
        const h = (m: (typeof sorted)[number]) => m.height || 80;

        // MAGNETIC focus, non-destructive: the ACTIVE card floats AT its own anchor
        // line (it's z-10, so it sits on top), while every other card keeps its
        // normal greedy-downward position — computed as if nothing were active. So
        // activating a card never shoves its neighbours. (The earlier up/down cascade
        // could fling all cards off-screen, e.g. when jumping via the "N open" pill.)
        const activeThread = activeId
          ? visibleCards.find((t) => t.id === activeId || t.comments.some((c) => c.id === activeId))
          : null;
        const activeItemId = composerOpen ? COMPOSER_ID : activeThread?.id;

        let prevBottom = -Infinity;
        for (const m of sorted) {
          const greedyY = Math.max(m.anchorY, prevBottom + BUBBLE_GAP);
          prevBottom = greedyY + h(m);
          const active = m.id === activeItemId;
          next.set(m.id, { anchorY: m.anchorY, cardY: active ? m.anchorY : greedyY });
        }

        let maxBottom = 0;
        for (const m of sorted) {
          const l = next.get(m.id);
          if (l) maxBottom = Math.max(maxBottom, l.cardY + h(m));
        }
        if (!layoutsEqual(next, layoutRef.current)) {
          layoutRef.current = next;
          setLayout(next);
        }
        setOriginX((prev) => (Math.abs(prev - origin) > 0.5 ? origin : prev));
        // Card-stack overflow BELOW the last text line — extra scroll the reader
        // needs to reach the lowest card. RESET to 0 with no visible cards (e.g.
        // everything seen), so stale reach never lingers as a blank gap.
        if (onContentExtent) {
          onContentExtent(
            sorted.length > 0 && maxBottom > lastLineBottom
              ? Math.ceil(maxBottom - lastLineBottom) + 24
              : 0,
          );
        }
        syncTransform();
      },
    });
  };

  // The scroll/resize listeners are installed once (per view) but must call the
  // LATEST recompute (which closes over the current threads); route through a ref
  // so a scroll-settle after a comment is added doesn't rebuild from stale threads.
  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;

  useLayoutEffect(() => {
    recompute();
    // openControl: opening a group popover can change a card's height, so the
    // greedy stack must re-measure or following cards overlap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, structureKey, repositionKey, replyingId, activeId, showSeen, seenIds, openControl, composerOpen, composerDraft]);

  // Wheel over the comment column scrolls the DOCUMENT. The column is a sibling
  // panel with no scrollable content of its own (cards are absolutely positioned
  // and moved by a transform), so without this, wheeling over a comment would die
  // here and the page would feel "scroll-locked" whenever the pointer sat on the
  // comments. Forward the delta to the editor's scroller (Google-Docs behaviour);
  // its scroll event then drives syncTransform, so cards track in lockstep.
  useEffect(() => {
    if (!view) return;
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // A scrollable region inside a card (a group's list, a long reply) scrolls
      // itself while it has room; only the rest of the wheel moves the document.
      if (innerScrollerTakesWheel(domWheelBox(e.target, el), e.deltaY)) return;
      const scroller = view.scrollDOM;
      // deltaMode 1 = lines, 2 = pages; approximate to px so trackpad + wheel match.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1;
      scroller.scrollTop += e.deltaY * unit;
      scroller.scrollLeft += e.deltaX * unit;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view]);

  // Scroll: per-frame transform (no React) + debounced settle-recompute so
  // off-screen estimates refine after scrolling stops. ResizeObserver → recompute.
  useEffect(() => {
    if (!view) return;
    const scrollEl = view.scrollDOM;
    syncTransformRef.current();
    let settle: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      syncTransformRef.current();
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => recomputeRef.current(), 120);
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => recomputeRef.current());
    ro.observe(scrollEl);
    return () => {
      if (settle) clearTimeout(settle);
      scrollEl.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const ordered = [...visibleCards].sort((a, b) => a.from - b.from);
  const isActiveCard = (c: SidebarCard) =>
    c.id === activeId || c.comments.some((cc) => cc.id === activeId);
  const active = ordered.find(isActiveCard) ?? null;
  const activeLayout = composerOpen
    ? layout.get(COMPOSER_ID) ?? null
    : active
      ? layout.get(active.id) ?? null
      : null;

  // The pill's arrows travel the rail like ↑/↓ (#43): from the selected card, or
  // from the first/last when none is.
  function stepCard(direction: 1 | -1) {
    const next = stepReviewCard(ordered, activeId, direction);
    if (next) onFocusThread(next);
  }

  // The group controls under a member comment (an edit or a note), keyed by that
  // comment so only the clicked card's surface opens.
  function renderGroupSurface(commentId: string) {
    const g = groupOf.get(commentId);
    if (!g) return null;
    const mode = openControl?.key === commentId ? openControl.mode : null;
    // A decision closes the surface: what is left of the group (the unticked rows)
    // stays as open cards to comment on or decide later (#25).
    const close = () => setOpenControl(null);
    return (
      <GroupSurface
        group={g}
        members={groupMembersOf.get(g.id) ?? []}
        notes={groupNotesOf.get(g.id) ?? []}
        mode={mode}
        onMode={(next) => setOpenControl(next ? { key: commentId, mode: next } : null)}
        onGroupEdit={(id, m, unticked) => { close(); onGroupEdit(id, m, unticked); }}
        onGroupApplyAndResolve={(id, unticked) => { close(); onGroupApplyAndResolve(id, unticked); }}
        onGroupResolveNotes={(id, unticked) => { close(); onGroupResolveNotes(id, unticked); }}
        onLocate={onLocate}
      />
    );
  }

  function closeReply() {
    setReplyingId(null);
    setReplyDraft("");
    setReplyMode("reply");
  }

  // Cancel and Escape share one path: a draft with text asks before it is thrown away.
  function cancelReply() {
    if (mayDiscardDraft(replyDraft, (message) => window.confirm(message))) closeReply();
  }

  function submitReply(card: SidebarCard, markSeen: boolean) {
    const text = replyDraft;
    if (text.trim()) {
      if (replyMode === "suggestion") onSuggestEdit(card, text);
      else (markSeen ? onReplyAndSeen : onReply)(card, text);
    }
    closeReply();
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {/* Zero-inbox counter: open (unseen) comments remaining (top-right, always shown).
          Click it to jump to the first open comment. */}
      {!composerOpen ? <div ref={statusRef} className="absolute right-3 top-3 z-20 flex select-none flex-col items-end transition-opacity duration-150">
        <div
          className={`flex h-6 items-center rounded-full text-[11px] font-medium text-[var(--panel)] shadow-sm ${unseenCount > 0 ? "bg-[var(--accent)]" : "bg-[var(--crit-ins)]"}`}
        >
          {ordered.length > 0 ? (
            <StatusStep direction={-1} label="Previous card (↑)" onStep={() => stepCard(-1)} />
          ) : null}
          {unseenCount > 0 ? (
            <button
              type="button"
              onClick={() => {
                const first = ordered.find((t) => t.kind === "comment" && !seenIds.has(t.id));
                if (first) onFocusThread(first);
              }}
              className={`flex h-6 items-center tabular-nums transition-transform hover:scale-105 ${ordered.length > 0 ? "px-1" : "px-2.5"}`}
              title={`${unseenCount} open comment${unseenCount === 1 ? "" : "s"} — jump to the first`}
            >
              {unseenCount} open
            </button>
          ) : (
            <span
              className={`pointer-events-none flex h-6 items-center gap-1 ${ordered.length > 0 ? "px-1" : "px-2.5"}`}
              title="No open comments — all caught up"
            >
              {/* ✓ glyph so the "done" state reads without relying on green (colourblind-safe). */}
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              all caught up
            </span>
          )}
          {ordered.length > 0 ? (
            <StatusStep direction={1} label="Next card (↓)" onStep={() => stepCard(1)} />
          ) : null}
        </div>
        {agentControl}
      </div> : null}
      {ordered.length === 0 && !composerOpen ? (
        <div className="px-3 pt-5 text-xs italic text-[var(--faint)]">
          {showSeen ? "No comments." : "No unseen comments."}
        </div>
      ) : (
        <>
          {/* Connector layer — overflow-visible so the active thread's line can run
              left across the gutter to the page edge. Transformed with the cards. */}
          <svg
            ref={connTrackRef}
            className="pointer-events-none absolute inset-0 h-full w-full"
            style={{ overflow: "visible" }}
            aria-hidden="true"
          >
            {activeLayout
              ? (() => {
                  const startX = originX;
                  const startY = activeLayout.anchorY + 7;
                  const endX = CARD_LEFT;
                  const endY = activeLayout.cardY + 18;
                  const midX = startX + (endX - startX) * 0.5;
                  const stroke = composerOpen
                    ? "var(--crit-comment)"
                    : authorColor(active?.comments[0]?.author ?? null);
                  return (
                    <g>
                      <circle cx={startX} cy={startY} r={2} fill={stroke} opacity={0.85} />
                      <path
                        d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={1}
                        strokeLinecap="round"
                        opacity={0.45}
                      />
                    </g>
                  );
                })()
              : null}
          </svg>

          {/* Cards — clipped so off-screen (translated) cards don't spill upward. */}
          <div className="absolute inset-0 overflow-hidden">
            <div ref={cardsTrackRef} className="absolute inset-x-0 top-0" style={{ willChange: "transform" }}>
              {composerOpen ? (() => {
                const composerLayout = layout.get(COMPOSER_ID);
                return (
                  <div
                    ref={(element) => {
                      if (element) cardRefs.current.set(COMPOSER_ID, element);
                      else cardRefs.current.delete(COMPOSER_ID);
                    }}
                    className="absolute z-20"
                    style={{
                      top: composerLayout?.cardY ?? 0,
                      left: CARD_LEFT,
                      right: 10,
                      visibility: composerLayout ? "visible" : "hidden",
                    }}
                  >
                    <CommentComposer
                      kind={composerKind}
                      draft={composerDraft}
                      anchored={composerAnchored}
                      onDraftChange={onComposerDraftChange}
                      onPost={onPostComment}
                      onPostDone={onPostCommentSeen}
                      onCancel={onCancelComposer}
                      extraControl={composerAgentControl}
                      // Focus once the composer is placed: a hidden element cannot
                      // take focus, so focusing on mount left it in the editor.
                      autoFocus={composerLayout !== undefined}
                    />
                  </div>
                );
              })() : null}
              {ordered.map((card) => {
                const l = layout.get(card.id);
                const isActive = isActiveCard(card);
                const isSeen = seenIds.has(card.id);
                const isExiting = exiting.has(card.id);
                // The suggestion group this card belongs to (if any) — drives a
                // colored spine + tag so same-group cards cluster visually.
                const cardGroupId =
                  card.comments.map((c) => groupOf.get(c.id)?.id).find(Boolean) ?? null;
                return (
                  <div
                    key={card.id}
                    ref={(el) => {
                      if (el) cardRefs.current.set(card.id, el);
                      else cardRefs.current.delete(card.id);
                    }}
                    onClick={() => onFocusThread(card)}
                    onContextMenu={card.kind === "comment" ? (e) => onCardContextMenu?.(card, e) : undefined}
                    className={[
                      "group absolute cursor-pointer rounded-[10px] px-3.5 py-3 text-left transition-shadow",
                      // Look C (#79): resting cards are flat grey; the active card
                      // lifts onto the page colour with a hairline ring.
                      isActive
                        ? "z-10 bg-[var(--panel)] shadow-[0_0_0_1px_var(--line-strong),0_6px_18px_rgba(0,0,0,0.08)]"
                        : "bg-[var(--bg)] hover:shadow-[0_0_0_1px_var(--line)]",
                    ].join(" ")}
                    style={{
                      top: l ? l.cardY : 0,
                      left: CARD_LEFT,
                      right: 10,
                      // No layout entry yet → HIDDEN with no transition, so a card
                      // never animates a "flight" up from top:0 (the visible amplifier
                      // behind the lift). Once positioned: mid-exit fades + shrinks,
                      // seen-but-unfocused recedes without lowering the contrast
                      // of every nested label and action.
                      visibility: l ? "visible" : "hidden",
                      opacity: isExiting ? 0 : 1,
                      backgroundColor: isSeen && !isActive ? "var(--bg)" : undefined,
                      outline: isSeen && !isActive ? "1px solid var(--line)" : undefined,
                      transform: isExiting ? "scale(0.96)" : undefined,
                      transition: l ? "opacity 200ms ease, transform 200ms ease" : "none",
                    }}
                  >
                    {cardGroupId ? (
                      // Colored spine — every card of one suggestion group shares this
                      // hue, so the set reads as a cluster even when the cards aren't
                      // adjacent. Absolute inside the (positioned) card, corners matched.
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 left-0 w-1 rounded-l-xl"
                        style={{ background: groupColor(cardGroupId) }}
                      />
                    ) : null}
                    {card.kind === "suggestion" ? (
                      // ── Suggestion card: Accept/Reject + the change preview ──
                      (() => {
                        const s = card.suggestion;
                        const badge = s.type === "substitute" ? "Replace" : s.type === "insert" ? "Add" : "Delete";
                        const badgeColor =
                          s.type === "delete" ? "var(--crit-del)" : s.type === "insert" ? "var(--crit-ins)" : "var(--crit-comment)";
                        return (
                          <>
                            <div className="absolute right-2 top-2.5 flex gap-1">
                              {s.type !== "delete" ? (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingId(s.id);
                                    setEditDraft(s.type === "insert" ? s.inner : s.newText);
                                  }}
                                  title="Edit suggestion"
                                  aria-label="Edit suggestion"
                                  className="flex h-6 w-6 items-center justify-center rounded-full border border-[var(--line-strong)] text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M12 20h9" />
                                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                  </svg>
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onAcceptSuggestion(card); }}
                                title="Accept suggestion"
                                aria-label="Accept suggestion"
                                className="flex h-6 w-6 items-center justify-center rounded-full border border-[var(--line-strong)] text-[var(--crit-ins)] hover:bg-[var(--crit-ins)] hover:text-[var(--panel)]"
                              >
                                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onRejectSuggestion(card); }}
                                title="Reject suggestion"
                                aria-label="Reject suggestion"
                                className="flex h-6 w-6 items-center justify-center rounded-full border border-[var(--line-strong)] text-[var(--crit-del)] hover:bg-[var(--crit-del)] hover:text-[var(--panel)]"
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                              </button>
                            </div>
                            <div className="mb-1 pr-16">
                              <span
                                className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                                style={{ color: badgeColor, backgroundColor: "var(--bg)" }}
                              >
                                {badge}
                              </span>
                            </div>
                            {editingId === s.id ? (
                              <ReviewTextEditor
                                value={editDraft}
                                label="Edit suggestion"
                                onChange={setEditDraft}
                                onSave={() => closeReviewEditorAfterSuccessfulSave(
                                  () => onEditSuggestion(s, editDraft),
                                  () => setEditingId(null),
                                )}
                                onCancel={() => setEditingId(null)}
                              />
                            ) : s.type === "insert" && card.standalone && richPreview ? (
                              <div className="mb-0.5 pr-8">
                                <p className="truncate text-[13px] font-medium leading-relaxed text-[var(--ink)]">
                                  {standaloneAdditionTitle(s.inner)}
                                </p>
                                <p className="mt-0.5 text-[11px] text-[var(--faint)]">
                                  Rendered in document
                                </p>
                              </div>
                            ) : (
                              <p className="mb-0.5 whitespace-pre-wrap text-[13px] leading-relaxed [overflow-wrap:anywhere]">
                                {s.type === "substitute" ? (
                                  <>
                                    <span className="text-[var(--crit-del)] line-through">{s.oldText}</span>
                                    <span className="px-1 text-[var(--faint)]">→</span>
                                    <span className="text-[var(--crit-ins)]">{s.newText}</span>
                                  </>
                                ) : s.type === "insert" ? (
                                  <span className="text-[var(--crit-ins)]">{s.inner}</span>
                                ) : (
                                  <span className="text-[var(--crit-del)] line-through">{s.inner}</span>
                                )}
                              </p>
                            )}
                          </>
                        );
                      })()
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onToggleSeen(card); }}
                          title={isSeen ? "Mark unseen" : "Mark seen"}
                          aria-pressed={isSeen}
                          className={`absolute right-9 top-2.5 rounded p-1 transition-opacity hover:bg-[var(--line)] ${
                            isSeen
                              ? "text-[var(--accent)] opacity-100"
                              : "text-[var(--faint)] opacity-0 hover:text-[var(--ink)] group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                          }`}
                          aria-label={isSeen ? "Mark unseen" : "Mark seen"}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onResolveThread(card); }}
                          title="Resolve thread"
                          className="absolute right-2 top-2.5 rounded p-1 text-[var(--accent-doc)] hover:bg-[var(--line)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                          aria-label="Resolve thread"
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                            <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </>
                    )}

                    {card.comments.map((c, i) => {
                      // A long thread at rest shows its first and last comment and
                      // a count of the rest (#79); focusing the card shows them all.
                      const collapsed = !isActive && card.comments.length > 3;
                      const hidden = card.comments.length - 2;
                      if (collapsed && i > 0 && i < card.comments.length - 1) {
                        return i === 1 ? (
                          <button
                            key={`${card.id}-more`}
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onFocusThread(card); }}
                            className="mt-2.5 flex w-full items-center gap-2 border-t border-[var(--line)] pt-2.5 text-[12px] font-medium text-[var(--accent-doc)] hover:underline"
                          >
                            {hidden} more {hidden === 1 ? "reply" : "replies"}
                          </button>
                        ) : null;
                      }
                      return (
                      <div
                        key={c.id}
                        className={`group/cmt ${i > 0 || card.kind === "suggestion" ? "mt-2.5 border-t border-[var(--line)] pt-2.5" : ""}`}
                      >
                        {/* A comment card's first row reserves space (pr-14) for the
                            seen/resolve buttons; replies + suggestion-card rows don't. */}
                        <div className={`mb-1 flex items-center gap-1.5 ${card.kind === "comment" && i === 0 ? "pr-14" : "pr-1"}`}>
                          <span
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                            style={{ backgroundColor: authorColor(c.author) }}
                            aria-hidden="true"
                          >
                            {(c.author ?? "?").replace(/^@/, "").charAt(0).toUpperCase()}
                          </span>
                          <span className="truncate text-[13px] font-semibold text-[var(--ink)]">
                            {c.author ?? "anonymous"}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const replacement = suggestionReplacement(c.body);
                              setEditingId(c.id);
                              setEditDraft(replacement ?? noteText(c.body));
                            }}
                            title={suggestionReplacement(c.body) === null ? "Edit comment" : "Edit suggestion"}
                            aria-label={suggestionReplacement(c.body) === null ? "Edit comment" : "Edit suggestion"}
                            className="ml-auto shrink-0 rounded p-0.5 text-[var(--faint)] opacity-0 transition-opacity hover:text-[var(--ink)] group-hover/cmt:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteComment(c);
                            }}
                            title="Delete this comment"
                            aria-label="Delete comment"
                            className="shrink-0 rounded p-0.5 text-[var(--faint)] opacity-0 transition-opacity hover:text-[var(--crit-del)] group-hover/cmt:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                        {(() => {
                          const repl = suggestionReplacement(c.body);
                          if (editingId === c.id) {
                            return (
                              <ReviewTextEditor
                                value={editDraft}
                                label={repl === null ? "Edit comment" : "Edit suggestion"}
                                onChange={setEditDraft}
                                onSave={() => closeReviewEditorAfterSuccessfulSave(
                                  () => repl === null
                                    ? onEditComment(c, withNoteGroup(editDraft.trim() ? noteGroupId(c.body) : null, editDraft))
                                    : onEditSuggestion(c, editDraft),
                                  () => setEditingId(null),
                                )}
                                onCancel={() => setEditingId(null)}
                              />
                            );
                          }
                          if (repl === null) {
                            // Non-active cards CLAMP long bodies (some review replies run
                            // hundreds of words) — otherwise the greedy stack cascades tens
                            // of thousands of px past the prose and the doc tail becomes a
                            // huge empty scroll. Focusing a card shows the full text.
                            return (
                              <>
                                <p className={`whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink)] [overflow-wrap:anywhere] ${isActive ? "" : "line-clamp-5"}`}>
                                  <CommentText body={noteText(c.body)} />
                                </p>
                                {renderGroupSurface(c.id)}
                              </>
                            );
                          }
                          // A structured SUGGEST: comment — show the proposed wording as a
                          // real suggested edit + an Apply (replaces the anchored span).
                          return (
                            <div>
                              <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-[var(--crit-comment)]">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                </svg>
                                Suggested edit
                              </div>
                              <p className={`whitespace-pre-wrap rounded bg-[var(--crit-ins-bg)] px-1.5 py-1 text-[13px] leading-relaxed [overflow-wrap:anywhere] text-[var(--crit-ins)] ${isActive ? "" : "line-clamp-5"}`}>
                                {repl.trim() ? repl : "(delete this span)"}
                              </p>
                              {applicableSuggestionIds.has(c.id) ? (
                                // Apply remains non-destructive; the combined action makes
                                // closing the discussion an explicit, undoable choice.
                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); onApplySuggestion(c); }}
                                    title="Apply this edit — replace the highlighted span with the proposed wording"
                                    className="flex items-center gap-1 rounded-md bg-[var(--crit-ins)] px-2 py-0.5 text-[11px] font-medium text-[var(--panel)]"
                                  >
                                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                    Apply
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); onApplyAndResolveSuggestion(c); }}
                                    title="Apply this edit and resolve the complete discussion in one undoable action"
                                    className="rounded-md border border-[var(--crit-ins)] px-2 py-0.5 text-[11px] font-medium text-[var(--crit-ins)]"
                                  >
                                    Apply &amp; resolve
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); onRejectSuggestionEdit(c); }}
                                    title="Reject this edit — keep the original span"
                                    className="flex items-center gap-1 rounded-md border border-[var(--line-strong)] px-2 py-0.5 text-[11px] font-medium text-[var(--crit-del)]"
                                  >
                                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                                    Reject
                                  </button>
                                </div>
                              ) : (
                                // SUGGEST: with no resolvable anchor span — show the proposal
                                // but no dead Apply. (Per the skill, SUGGEST: must anchor to a
                                // {==span==}; an un-anchored one is a misuse we surface gently.)
                                <p className="mt-1 text-[10px] italic text-[var(--faint)]">
                                  no anchored span to apply to
                                </p>
                              )}
                              {/* Member of a review group (#21): surface the whole-set
                                  controls — every member edit lands as ONE undoable apply. */}
                              {renderGroupSurface(c.id)}
                            </div>
                          );
                        })()}
                      </div>
                      );
                    })}

                    {replyingId === card.id ? (
                      <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
                        <textarea
                          autoFocus
                          rows={1}
                          value={replyDraft}
                          onChange={(e) => setReplyDraft(e.target.value)}
                          onKeyDown={(e) => handleCommentKey(e, () => submitReply(card, false), () => submitReply(card, card.kind === "comment"), cancelReply)}
                          aria-label={replyMode === "suggestion" ? "Suggested replacement" : "Reply"}
                          placeholder={replyMode === "suggestion" ? "Write the replacement text…" : "Reply…  (⇧↵ for a new line)"}
                          className="block max-h-40 w-full resize-none overflow-y-auto rounded-md border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-1.5 text-[13px] leading-relaxed text-[var(--ink)] outline-none [field-sizing:content] focus:border-[var(--accent)]"
                        />
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => submitReply(card, false)}
                            className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-[var(--panel)]"
                          >
                            {replyMode === "suggestion" ? "Create suggestion" : "Reply"} <span className="text-[10px] font-normal opacity-70">{MOD}↵</span>
                          </button>
                          {card.kind === "comment" && replyMode === "reply" ? (
                            <button
                              type="button"
                              onClick={() => submitReply(card, true)}
                              title="Reply and mark this thread seen"
                              className="flex items-center gap-1.5 rounded-md border border-[var(--line-strong)] px-2.5 py-1 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--line)]"
                            >
                              Reply &amp; seen <span className="text-[10px] font-normal text-[var(--faint)]">{MOD}⇧↵</span>
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={cancelReply}
                            title="Close the reply box without posting"
                            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
                          >
                            Cancel <span className="text-[10px] font-normal text-[var(--faint)]">esc</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setReplyingId(card.id);
                            setReplyDraft("");
                            setReplyMode("reply");
                            onFocusThread(card);
                          }}
                          className="text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"
                        >
                          Reply
                        </button>
                        {card.kind === "comment" ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReplyingId(card.id);
                              setReplyDraft("");
                              setReplyMode("suggestion");
                              onFocusThread(card);
                            }}
                            title="Write a replacement proposal for this anchored text"
                            className="flex items-center gap-1 text-[12px] text-[var(--crit-comment)] hover:opacity-80"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                            </svg>
                            Suggest edit
                          </button>
                        ) : null}
                        {card.kind === "comment" && anchoredCardIds?.has(card.id) ? (
                          threadEditRequested(card) ? (
                            <span className="text-[12px] italic text-[var(--faint)]" title="Waiting for an agent to post a SUGGEST on this thread">
                              Edit requested
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onAskAgent(card);
                              }}
                              title={`Reply “${EDIT_REQUEST_TEXT}” at the end of this thread and mark it seen; agents find it with acm threads`}
                              className="text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"
                            >
                              Ask agent
                            </button>
                          )
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** A plain comment body with its URLs and `[text](url)` links made clickable
 *  (#68). Links open in a new tab and never activate the card underneath. */
function CommentText({ body }: { body: string }) {
  return (
    <>
      {commentSegments(body).map((segment, index) =>
        segment.kind === "text" ? (
          segment.text
        ) : (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={segment.href}
            className="text-[var(--accent)] underline decoration-[var(--line-strong)] underline-offset-2 hover:decoration-current"
          >
            {segment.text}
          </a>
        ),
      )}
    </>
  );
}

// ── Suggestion-group "see the whole set" surface ──────────────────────────────
// A group member's card carries controls to review + apply the WHOLE group: the
// ⛓ chip opens a popover listing every member (old → new, click to locate) with
// the atomic Apply-all/Reject-all. (Three layouts were compared live — popover /
// inline-expand / grouped panel — popover won and the others were removed.)

/** One of the status pill's step arrows. */
function StatusStep({ direction, label, onStep }: { direction: 1 | -1; label: string; onStep: () => void }) {
  return (
    <button
      type="button"
      onClick={onStep}
      aria-label={label}
      title={label}
      className={`flex h-6 w-6 items-center justify-center opacity-80 hover:opacity-100 ${direction < 0 ? "rounded-l-full pl-1" : "rounded-r-full pr-1"}`}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d={direction < 0 ? "M3.5 10.5 8 6l4.5 4.5" : "M3.5 5.5 8 10l4.5-4.5"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** Adapt a DOM element for {@link innerScrollerTakesWheel}; the chain ends at the
 *  rail container, which only forwards the wheel. */
function domWheelBox(node: EventTarget | null, rail: HTMLElement): WheelBox | null {
  if (!(node instanceof HTMLElement) || node === rail) return null;
  return {
    get scrollTop() { return node.scrollTop; },
    get scrollHeight() { return node.scrollHeight; },
    get clientHeight() { return node.clientHeight; },
    get scrollable() {
      const overflow = getComputedStyle(node).overflowY;
      return overflow === "auto" || overflow === "scroll";
    },
    get parent() { return domWheelBox(node.parentElement, rail); },
  };
}

type GroupSurfaceMode = "popover" | "panel";

/** Groups with more members than this open straight into the side panel: the
 *  popover fits about six rows. */
export const GROUP_PANEL_THRESHOLD = 6;

/** "14 edits", "3 notes", "2 edits · 3 notes". */
export function groupCountLabel(group: Pick<ReviewGroupInfo, "edits" | "notes">): string {
  const part = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [group.edits ? part(group.edits, "edit") : null, group.notes ? part(group.notes, "note") : null]
    .filter(Boolean)
    .join(" · ");
}

/** Where the group panel sits, in viewport px (#25): just under the card's group
 *  link and flush with the card's right edge, so it reads as coming from that
 *  card and covers the cards column rather than the prose. Above the link when
 *  the window has no room below; the full window height when neither side fits. */
const PANEL_MARGIN = 16;
const PANEL_GAP = 6;
const PANEL_WIDTH = 400;
const PANEL_MIN_HEIGHT = 320;

export interface GroupPanelPlacement {
  top?: number;
  bottom?: number;
  right: number;
  width: number;
  maxHeight: number;
}

export function groupPanelPlacement(
  anchor: { top: number; bottom: number; right: number },
  viewport: { width: number; height: number },
): GroupPanelPlacement {
  const width = Math.min(PANEL_WIDTH, viewport.width - 2 * PANEL_MARGIN);
  let edge = Math.min(anchor.right, viewport.width - PANEL_MARGIN);
  if (edge - width < PANEL_MARGIN) edge = PANEL_MARGIN + width;
  const right = viewport.width - edge;
  const below = viewport.height - PANEL_MARGIN - (anchor.bottom + PANEL_GAP);
  const above = anchor.top - PANEL_GAP - PANEL_MARGIN;
  if (below >= PANEL_MIN_HEIGHT) {
    const top = Math.max(PANEL_MARGIN, anchor.bottom + PANEL_GAP);
    return { top, right, width, maxHeight: viewport.height - PANEL_MARGIN - top };
  }
  if (above >= PANEL_MIN_HEIGHT) {
    const bottom = Math.max(PANEL_MARGIN, viewport.height - (anchor.top - PANEL_GAP));
    return { bottom, right, width, maxHeight: viewport.height - PANEL_MARGIN - bottom };
  }
  return { top: PANEL_MARGIN, right, width, maxHeight: viewport.height - 2 * PANEL_MARGIN };
}

/** Which rows of an open group surface are left out of its decision (#25). Every
 *  row starts ticked; the set holds the unticked comment ids. */
interface GroupSelection {
  unticked: ReadonlySet<string>;
  onToggle: (commentId: string) => void;
  onToggleAll: (tick: boolean) => void;
}

/** The members of a group, in document order: edits as old → new rows, notes as
 *  their text, each with a checkbox deciding whether the group's buttons act on it.
 *  Click a row to scroll to + flash the span it is about (onLocate). */
export function GroupMembers({
  members,
  notes,
  large = false,
  onLocate,
  unticked,
  onToggle,
}: {
  members: SuggestionGroupMember[];
  notes: GroupNoteMember[];
  large?: boolean;
  onLocate: (from: number, to: number) => void;
} & Pick<GroupSelection, "unticked" | "onToggle">) {
  const rows = [
    ...members.map((m) => ({ key: m.commentId, at: m.from, from: m.anchorFrom, to: m.anchorTo, edit: m, note: null })),
    ...notes.map((n) => ({ key: n.commentId, at: n.threadFrom, from: n.anchorFrom, to: n.anchorTo, edit: null, note: n })),
  ].sort((a, b) => a.at - b.at);
  return (
    <ul className={large ? "divide-y divide-[var(--line)]" : "space-y-0.5"}>
      {rows.map((row, i) => {
        const ticked = !unticked.has(row.key);
        return (
          <li key={row.key} className={`flex items-start ${ticked ? "" : "opacity-50"}`}>
            <input
              type="checkbox"
              value={row.key}
              checked={ticked}
              onChange={(e) => { e.stopPropagation(); onToggle(row.key); }}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Include item ${i + 1}`}
              title={ticked ? "Untick to leave this one open" : "Tick to include this one"}
              className={`shrink-0 cursor-pointer accent-[var(--crit-ins)] ${large ? "ml-2 mt-[9px]" : "ml-1 mt-[5px]"}`}
            />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onLocate(row.from, row.to); }}
              title="Jump to this item in the document"
              className={`flex min-w-0 flex-1 gap-1.5 rounded text-left leading-snug hover:bg-[var(--line)] ${large ? "px-2 py-1.5 text-[13px]" : "px-1 py-0.5 text-[12px]"}`}
            >
              <span className="shrink-0 tabular-nums text-[var(--faint)]">{i + 1}</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {row.edit ? (
                  <>
                    {row.edit.anchorText ? (
                      <>
                        <span className="text-[var(--crit-del)] line-through">{row.edit.anchorText}</span>
                        <span className="px-1 text-[var(--faint)]">→</span>
                      </>
                    ) : null}
                    {row.edit.isDelete ? (
                      <span className="italic text-[var(--crit-del)]">(delete)</span>
                    ) : (
                      <span className="text-[var(--crit-ins)]">{row.edit.replacement}</span>
                    )}
                  </>
                ) : row.note ? (
                  <>
                    {row.note.anchorText ? (
                      <span className="mr-1 rounded bg-[var(--crit-hl-bg)] px-1 text-[var(--ink)]">{row.note.anchorText}</span>
                    ) : null}
                    <span className="text-[var(--ink)]">{row.note.text}</span>
                  </>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** "Untick all" / "Tick all" for a group surface's rows. */
function TickAllToggle({ allUnticked, onToggleAll }: { allUnticked: boolean; onToggleAll: (tick: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggleAll(allUnticked); }}
      className="rounded px-1 text-[11px] text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
    >
      {allUnticked ? "Tick all" : "Untick all"}
    </button>
  );
}

/** Apply / Reject for the group's ticked edits and Resolve for its ticked notes,
 *  each one undoable edit. With every row ticked they decide the whole group, as
 *  before (#25); unticked rows stay as open cards. */
function GroupActions({
  group,
  members,
  notes,
  unticked,
  large = false,
  onGroupEdit,
  onGroupApplyAndResolve,
  onGroupResolveNotes,
}: {
  group: ReviewGroupInfo;
  members: SuggestionGroupMember[];
  notes: GroupNoteMember[];
  unticked: ReadonlySet<string>;
  large?: boolean;
  onGroupEdit: (groupId: string, mode: "accept" | "reject", unticked?: ReadonlySet<string>) => void;
  onGroupApplyAndResolve: (groupId: string, unticked?: ReadonlySet<string>) => void;
  onGroupResolveNotes: (groupId: string, unticked?: ReadonlySet<string>) => void;
}) {
  const { id, edits, notes: noteCount } = group;
  const editIds = members.map((m) => m.commentId);
  const noteIds = notes.map((n) => n.commentId);
  const tickedEdits = editIds.filter((e) => !unticked.has(e)).length;
  const tickedNotes = noteIds.filter((n) => !unticked.has(n)).length;
  const someEdits = tickedEdits < editIds.length;
  const someNotes = tickedNotes < noteIds.length;
  // Every button gets the whole unticked set, edits and notes alike: a thread can
  // hold both, and deciding one must not remove the other (#25). With nothing
  // unticked the group is decided whole, as before.
  const leftOut = unticked.size ? unticked : undefined;
  const left = (n: number) => (n > 0 ? `; the ${n} unticked stay open` : "");
  // The panel's buttons match the card-sized reply buttons; the popover's stay compact.
  const size = `${large ? "px-2.5 py-1 text-[12px]" : "px-1.5 py-0.5 text-[10px]"} disabled:cursor-not-allowed disabled:opacity-40`;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${large ? "mt-3" : "mt-2"}`}>
      {edits > 0 ? (
        <>
          <button
            type="button"
            disabled={tickedEdits === 0}
            onClick={(e) => { e.stopPropagation(); onGroupEdit(id, "accept", leftOut); }}
            title={`Apply ${someEdits ? `the ${tickedEdits} ticked` : `all ${edits}`} edits (one undo)${left(editIds.length - tickedEdits)}`}
            className={`rounded-md bg-[var(--crit-ins)] ${size} font-medium text-[var(--panel)]`}
          >
            {someEdits ? `Apply ${tickedEdits} of ${editIds.length}` : `Apply all ${edits}`}
          </button>
          <button
            type="button"
            disabled={tickedEdits === 0}
            onClick={(e) => { e.stopPropagation(); onGroupApplyAndResolve(id, leftOut); }}
            title={`Apply ${someEdits ? `the ${tickedEdits} ticked` : `all ${edits}`} edits and resolve their discussions (one undo)${left(editIds.length - tickedEdits)}`}
            className={`rounded-md border border-[var(--crit-ins)] ${size} font-medium text-[var(--crit-ins)]`}
          >
            {someEdits ? `Apply & resolve ${tickedEdits}` : "Apply & resolve all"}
          </button>
          <button
            type="button"
            disabled={tickedEdits === 0}
            onClick={(e) => { e.stopPropagation(); onGroupEdit(id, "reject", leftOut); }}
            title={`Reject ${someEdits ? `the ${tickedEdits} ticked` : `all ${edits}`} edits (one undo)${left(editIds.length - tickedEdits)}`}
            className={`rounded-md border border-[var(--line-strong)] ${size} font-medium text-[var(--crit-del)]`}
          >
            {someEdits ? `Reject ${tickedEdits}` : "Reject all"}
          </button>
        </>
      ) : null}
      {noteCount > 0 ? (
        <button
          type="button"
          disabled={tickedNotes === 0}
          onClick={(e) => { e.stopPropagation(); onGroupResolveNotes(id, leftOut); }}
          title={`Resolve ${someNotes ? `the ${tickedNotes} ticked` : `all ${noteCount}`} notes (one undo)${left(noteIds.length - tickedNotes)}`}
          className={`rounded-md border border-[var(--line-strong)] ${size} font-medium text-[var(--ink)] hover:bg-[var(--line)]`}
        >
          {someNotes
            ? `Resolve ${tickedNotes} of ${noteIds.length} ${noteIds.length === 1 ? "note" : "notes"}`
            : `Resolve all ${noteCount} ${noteCount === 1 ? "note" : "notes"}`}
        </button>
      ) : null}
    </div>
  );
}

interface GroupSurfaceProps {
  group: ReviewGroupInfo;
  members: SuggestionGroupMember[];
  notes: GroupNoteMember[];
  mode: GroupSurfaceMode | null;
  onMode: (mode: GroupSurfaceMode | null) => void;
  onGroupEdit: (groupId: string, mode: "accept" | "reject", unticked?: ReadonlySet<string>) => void;
  onGroupApplyAndResolve: (groupId: string, unticked?: ReadonlySet<string>) => void;
  onGroupResolveNotes: (groupId: string, unticked?: ReadonlySet<string>) => void;
  onLocate: (from: number, to: number) => void;
}

type GroupPanelProps = GroupSurfaceProps &
  GroupSelection & {
    /** The card's group control: the panel opens beside it (#25). Without it the
     *  panel falls back to the window's top-right corner. */
    anchor?: { readonly current: HTMLElement | null };
  };

function placeBeside(anchor: GroupPanelProps["anchor"]): GroupPanelPlacement | null {
  if (!anchor?.current || typeof window === "undefined") return null;
  return groupPanelPlacement(anchor.current.getBoundingClientRect(), {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

/** The panel for reviewing a whole group (#67/#74), opened beside the card it came
 *  from (#25): most of the window tall at most, its list scrolling by wheel,
 *  trackpad and keyboard (it takes focus, so ↑/↓/PageUp/PageDown/Space work at
 *  once). Escape closes it. It stays put while the document scrolls, so a row's
 *  jump link shows the span in place. */
export function GroupPanel(props: GroupPanelProps) {
  const { group, members, notes, onMode, onLocate, unticked, onToggle, onToggleAll, anchor } = props;
  const listRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState(() => placeBeside(anchor));
  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!anchor || typeof window === "undefined") return;
    const onResize = () => setPlacement(placeBeside(anchor));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [anchor]);
  const rowCount = members.length + notes.length;
  return (
    <div
      data-group-ui
      role="dialog"
      aria-label={`Group ${group.id}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onMode(null);
        }
      }}
      style={placement ?? undefined}
      className={`fixed z-50 flex flex-col rounded-xl border border-[var(--line-strong)] bg-[var(--panel)] p-3 text-[var(--ink)] shadow-[0_12px_40px_rgba(0,0,0,0.22)] ${placement ? "" : "right-4 top-16 max-h-[calc(100vh-5rem)] w-[min(34rem,calc(100vw-2rem))]"}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium" style={{ color: groupColor(group.id) }}>
          <span aria-hidden="true">⛓</span> {group.id} · {groupCountLabel(group)}
        </span>
        <span className="flex items-center gap-1">
          <TickAllToggle allUnticked={rowCount > 0 && unticked.size >= rowCount} onToggleAll={onToggleAll} />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onMode(null); }}
            aria-label="Close"
            title="Close (esc)"
            className="rounded p-1 text-[var(--faint)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </span>
      </div>
      <div
        ref={listRef}
        tabIndex={0}
        aria-label="Group members"
        className="min-h-0 shrink overflow-y-auto rounded-lg border border-[var(--line)] outline-none"
      >
        <GroupMembers members={members} notes={notes} large onLocate={onLocate} unticked={unticked} onToggle={onToggle} />
      </div>
      <GroupActions
        group={group}
        members={members}
        notes={notes}
        unticked={unticked}
        large
        onGroupEdit={props.onGroupEdit}
        onGroupApplyAndResolve={props.onGroupApplyAndResolve}
        onGroupResolveNotes={props.onGroupResolveNotes}
      />
    </div>
  );
}

export function GroupSurface(props: GroupSurfaceProps) {
  const { group, members, notes, mode, onMode, onLocate } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Every row starts ticked; closing the surface forgets what was unticked.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (mode === null) setUnticked((prev) => (prev.size ? new Set() : prev));
  }, [mode]);
  const rowIds = [...members.map((m) => m.commentId), ...notes.map((n) => n.commentId)];
  const selection: GroupSelection = {
    unticked,
    onToggle: (commentId) =>
      setUnticked((prev) => {
        const next = new Set(prev);
        if (!next.delete(commentId)) next.add(commentId);
        return next;
      }),
    onToggleAll: (tick) => setUnticked(tick ? new Set() : new Set(rowIds)),
  };
  // Group tag, colour-matched to the card's spine so identity is unmistakable.
  const color = groupColor(group.id);
  const chip = (
    <span style={{ color }}>
      <span aria-hidden="true">⛓</span> {group.id} · {groupCountLabel(group)}
    </span>
  );
  const large = group.edits + group.notes > GROUP_PANEL_THRESHOLD;

  // Small groups open a popover off the card. It opens UPWARD (the control sits at
  // the card's bottom) so it overlays the visible card body rather than spilling
  // past the clipped column edge. Large groups, or ⤢, open the panel beside the card.
  return (
    <div
      ref={rootRef}
      data-group-ui
      className="relative mt-1.5 border-t border-[var(--line)] pt-1.5 text-[10px] text-[var(--muted)]"
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onMode(mode ? null : large ? "panel" : "popover"); }}
        className="flex items-center gap-1 hover:text-[var(--ink)]"
        aria-expanded={mode !== null}
      >
        {chip} <span aria-hidden="true">▾</span>
      </button>
      {mode === "popover" ? (
        <div
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onMode(null);
            }
          }}
          className="absolute bottom-full left-0 z-50 mb-1 w-72 rounded-xl border border-[var(--line-strong)] bg-[var(--panel)] p-2.5 text-[var(--ink)] shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-medium">{chip}</span>
            <span className="flex items-center gap-0.5">
              <TickAllToggle
                allUnticked={rowIds.length > 0 && unticked.size >= rowIds.length}
                onToggleAll={selection.onToggleAll}
              />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onMode("panel"); }}
                aria-label="Open in a larger panel"
                title="Open in a larger panel"
                className="rounded p-0.5 text-[var(--faint)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" /></svg>
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onMode(null); }}
                aria-label="Close"
                className="rounded p-0.5 text-[var(--faint)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              </button>
            </span>
          </div>
          <div tabIndex={0} aria-label="Group members" className="max-h-60 overflow-y-auto pr-0.5 outline-none">
            <GroupMembers members={members} notes={notes} onLocate={onLocate} {...selection} />
          </div>
          <GroupActions
            group={group}
            members={members}
            notes={notes}
            unticked={unticked}
            onGroupEdit={props.onGroupEdit}
            onGroupApplyAndResolve={props.onGroupApplyAndResolve}
            onGroupResolveNotes={props.onGroupResolveNotes}
          />
        </div>
      ) : null}
      {mode === "panel" ? createPortal(<GroupPanel {...props} {...selection} anchor={rootRef} />, document.body) : null}
    </div>
  );
}

export type { CommentSidebarProps };
