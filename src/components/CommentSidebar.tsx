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
import type { MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import type { EditorView } from "@codemirror/view";
import { MOD } from "../lib/platform";
import type { SidebarCard, CommentToken } from "../lib/types";
import { suggestionReplacement } from "../lib/criticmarkup";
import type { SuggestionGroupMember } from "../lib/criticmarkup";
import type { GroupView } from "../lib/viewSettings";
import { authorColor, groupColor } from "./authorColor";

interface CommentSidebarProps {
  view: EditorView | null;
  /** Comment threads AND suggestions, as one ordered set (see groupCards). */
  cards: SidebarCard[];
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
  onReply: (card: SidebarCard, text: string) => void;
  /** Reply AND mark the whole thread seen (dismiss it + advance) — ⌘⇧↵. */
  onReplyAndSeen: (card: SidebarCard, text: string) => void;
  /** One-click: post a "suggest edit" reply + mark the thread seen (agent hand-off). */
  onSuggestEdit: (card: SidebarCard) => void;
  /** Apply a structured `SUGGEST:` comment — replace its anchored span with the
   *  proposed wording. */
  onApplySuggestion: (comment: CommentToken) => void;
  /** Reject a structured `SUGGEST:` comment — keep the original span (mirror of Apply). */
  onRejectSuggestionEdit: (comment: CommentToken) => void;
  /** Ids of SUGGEST: comments with a resolvable anchor → their Apply is real.
   *  A SUGGEST: not in this set shows the proposal but no (dead) Apply button. */
  applicableSuggestionIds: Set<string>;
  /** commentId → its suggestion group (id + member count), for SUGGEST[g:id]
   *  members (#21). Only real groups (≥2 members) appear here. */
  suggestionGroupOf: Map<string, { id: string; size: number }>;
  /** groupId → its members ({old span, new wording}, in document order) — the data
   *  the popover / inline-expand views list so the whole set is reviewable before an
   *  Apply-all. */
  groupMembersOf: Map<string, SuggestionGroupMember[]>;
  /** Which "see the group together" layout to render (comparison build). */
  groupView: GroupView;
  /** Accept/reject EVERY member of a group as one atomic edit. */
  onGroupEdit: (groupId: string, mode: "accept" | "reject") => void;
  /** Accept / reject a suggestion card's suggestion. */
  onAcceptSuggestion: (card: SidebarCard) => void;
  onRejectSuggestion: (card: SidebarCard) => void;
  onFocusThread: (card: SidebarCard) => void;
  onCardContextMenu?: (card: SidebarCard, e: ReactMouseEvent) => void;
  /** How far the lowest card sticks out BELOW the document's last line (px, ≥0).
   *  App applies it as extra scroller bottom padding so those cards stay
   *  scroll-reachable — without stretching the page sheet itself. */
  onContentExtent?: (px: number) => void;
}

const BUBBLE_GAP = 16;
const CARD_LEFT = 18; // px from the column's left edge to the card

// Re-exported so existing `import { MOD } from "./CommentSidebar"` callers keep
// working; the glyph itself now lives in lib/platform.
export { MOD };

// Keyboard model shared by the reply box AND the header composer, so both behave
// identically. Bound to a multi-line <textarea>:
//   ↵ / ⌘↵         → submit
//   ⌘⇧↵ / Ctrl+⇧↵  → submit + mark seen
//   ⇧↵             → new line (NOT intercepted — the textarea inserts it)
//   Esc            → cancel
export function handleCommentKey(
  e: ReactKeyboardEvent,
  onSubmit: () => void,
  onSubmitSeen: () => void,
  onCancel: () => void,
) {
  if (e.key === "Escape") {
    e.preventDefault();
    onCancel();
    return;
  }
  if (e.key !== "Enter") return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.shiftKey && !mod) return; // ⇧↵ → new line (let the textarea handle it)
  e.preventDefault();
  (e.shiftKey && mod ? onSubmitSeen : onSubmit)();
}

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

export default function CommentSidebar(props: CommentSidebarProps) {
  const {
    view,
    cards,
    activeId,
    seenIds,
    showSeen,
    unseenCount,
    onToggleSeen,
    repositionKey,
    replyTarget,
    onResolveThread,
    onDeleteComment,
    onReply,
    onReplyAndSeen,
    onSuggestEdit,
    onApplySuggestion,
    suggestionGroupOf,
    groupMembersOf,
    groupView,
    onGroupEdit,
    onRejectSuggestionEdit,
    applicableSuggestionIds,
    onAcceptSuggestion,
    onRejectSuggestion,
    onFocusThread,
    onCardContextMenu,
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
  const visibleCards = showSeen
    ? cards
    : cards.filter((t) => !seenIds.has(t.id) || exiting.has(t.id));

  // Recompute the layout only when the STRUCTURE changes — the set of thread ids and
  // their anchor offsets — NOT on every keystroke. `threads` is a fresh array each
  // render (groupThreads rebuilds it), so depending on it re-measured constantly,
  // often against not-yet-settled editor geometry → the "all cards lift up" glitch.
  // `from` is included because typing ABOVE a comment legitimately shifts its anchor.
  const structureKey = visibleCards.map((t) => `${t.id}:${t.from}`).join("|");

  const containerRef = useRef<HTMLDivElement | null>(null);
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
  // Which group CONTROL's "see the whole set" surface is open (popover / inline
  // expand), keyed by the member comment whose chip was clicked — so opening it on
  // one member card doesn't fan the popover out across every sibling card. One at a
  // time — opening another closes the last.
  const [openControl, setOpenControl] = useState<string | null>(null);
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
    }
  }, [replyTarget]);

  // Cheap per-frame: keep the layers aligned to the editor's scroll. No React.
  const syncTransform = () => {
    const v = view;
    if (!v) return;
    const t = `translate3d(0, ${-v.scrollDOM.scrollTop}px, 0)`;
    if (cardsTrackRef.current) cardsTrackRef.current.style.transform = t;
    if (connTrackRef.current) connTrackRef.current.style.transform = t;
  };

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
        const measured = visibleCards.map((t) => ({
          id: t.id,
          anchorY: docTop + view0.lineBlockAt(t.from).top,
          height: cardRefs.current.get(t.id)?.offsetHeight ?? 0,
        }));
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

        let prevBottom = -Infinity;
        for (const m of sorted) {
          const greedyY = Math.max(m.anchorY, prevBottom + BUBBLE_GAP);
          prevBottom = greedyY + h(m);
          const active = activeThread != null && m.id === activeThread.id;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, structureKey, repositionKey, replyingId, activeId, showSeen, seenIds]);

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
    syncTransform();
    let settle: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      syncTransform();
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
  const activeLayout = active ? layout.get(active.id) : null;

  function submitReply(card: SidebarCard, markSeen: boolean) {
    const text = replyDraft.trim();
    if (text) (markSeen ? onReplyAndSeen : onReply)(card, text);
    setReplyingId(null);
    setReplyDraft("");
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {/* Zero-inbox counter: open (unseen) comments remaining (top-right, always shown).
          Click it to jump to the first open comment. */}
      <div className="absolute right-3 top-3 z-20 select-none">
        {unseenCount > 0 ? (
          <button
            type="button"
            onClick={() => {
              const first = ordered.find((t) => t.kind === "comment" && !seenIds.has(t.id));
              if (first) onFocusThread(first);
            }}
            className="flex h-6 items-center rounded-full bg-[var(--accent)] px-2.5 text-[11px] font-medium tabular-nums text-[var(--panel)] shadow-sm transition-transform hover:scale-105"
            title={`${unseenCount} open comment${unseenCount === 1 ? "" : "s"} — jump to the first`}
          >
            {unseenCount} open
          </button>
        ) : (
          <span
            className="pointer-events-none flex h-6 items-center gap-1 rounded-full bg-[var(--crit-ins)] px-2.5 text-[11px] font-medium text-[var(--panel)] shadow-sm"
            title="No open comments — all caught up"
          >
            {/* ✓ glyph so the "done" state reads without relying on green (colourblind-safe). */}
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            all caught up
          </span>
        )}
      </div>
      {ordered.length === 0 ? (
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
            {active && activeLayout
              ? (() => {
                  const startX = originX;
                  const startY = activeLayout.anchorY + 7;
                  const endX = CARD_LEFT;
                  const endY = activeLayout.cardY + 18;
                  const midX = startX + (endX - startX) * 0.5;
                  const stroke = authorColor(active.comments[0]?.author ?? null);
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
              {ordered.map((card) => {
                const l = layout.get(card.id);
                const isActive = isActiveCard(card);
                const isSeen = seenIds.has(card.id);
                const isExiting = exiting.has(card.id);
                // The suggestion group this card belongs to (if any) — drives a
                // colored spine + tag so same-group cards cluster visually.
                const cardGroupId =
                  card.comments.map((c) => suggestionGroupOf.get(c.id)?.id).find(Boolean) ?? null;
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
                      "group absolute cursor-pointer rounded-xl bg-[var(--panel)] px-3.5 py-3 text-left transition-shadow",
                      isActive
                        ? "z-10 shadow-[0_4px_16px_rgba(0,0,0,0.14)] ring-1 ring-[var(--line-strong)]"
                        : "shadow-[0_1px_3px_rgba(0,0,0,0.08)] hover:shadow-[0_3px_10px_rgba(0,0,0,0.12)]",
                    ].join(" ")}
                    style={{
                      top: l ? l.cardY : 0,
                      left: CARD_LEFT,
                      right: 10,
                      // No layout entry yet → HIDDEN with no transition, so a card
                      // never animates a "flight" up from top:0 (the visible amplifier
                      // behind the lift). Once positioned: mid-exit fades + shrinks,
                      // seen-but-unfocused dims, and the transition smooths it.
                      visibility: l ? "visible" : "hidden",
                      opacity: isExiting ? 0 : isSeen && !isActive ? 0.45 : 1,
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
                                className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                                style={{ color: badgeColor, backgroundColor: "var(--bg)" }}
                              >
                                {badge}
                              </span>
                            </div>
                            <p className="mb-0.5 whitespace-pre-wrap text-[13px] leading-relaxed">
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
                              : "text-[var(--faint)] opacity-0 hover:text-[var(--ink)] group-hover:opacity-100"
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
                          className="absolute right-2 top-2.5 rounded p-1 text-[var(--faint)] opacity-0 transition-opacity hover:bg-[var(--line)] hover:text-[var(--ink)] group-hover:opacity-100"
                          aria-label="Resolve thread"
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                            <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </>
                    )}

                    {card.comments.map((c, i) => (
                      <div
                        key={c.id}
                        className={`group/cmt ${i > 0 || card.kind === "suggestion" ? "mt-2.5 border-t border-[var(--line)] pt-2.5" : ""}`}
                      >
                        {/* A comment card's first row reserves space (pr-14) for the
                            seen/resolve buttons; replies + suggestion-card rows don't. */}
                        <div className={`mb-1 flex items-center gap-1.5 ${card.kind === "comment" && i === 0 ? "pr-14" : "pr-1"}`}>
                          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: authorColor(c.author) }} />
                          <span className="truncate text-[12px] font-medium" style={{ color: authorColor(c.author) }}>
                            {c.author ?? "anonymous"}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteComment(c);
                            }}
                            title="Delete this comment"
                            aria-label="Delete comment"
                            className="ml-auto shrink-0 rounded p-0.5 text-[var(--faint)] opacity-0 transition-opacity hover:text-[var(--crit-del)] group-hover/cmt:opacity-100"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                        {(() => {
                          const repl = suggestionReplacement(c.body);
                          if (repl === null) {
                            // Non-active cards CLAMP long bodies (some review replies run
                            // hundreds of words) — otherwise the greedy stack cascades tens
                            // of thousands of px past the prose and the doc tail becomes a
                            // huge empty scroll. Focusing a card shows the full text.
                            return (
                              <p className={`whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink)] ${isActive ? "" : "line-clamp-5"}`}>
                                {c.body}
                              </p>
                            );
                          }
                          // A structured SUGGEST: comment — show the proposed wording as a
                          // real suggested edit + an Apply (replaces the anchored span).
                          return (
                            <div>
                              <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--crit-comment)]">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                </svg>
                                Suggested edit
                              </div>
                              <p className={`whitespace-pre-wrap rounded bg-[var(--crit-ins-bg)] px-1.5 py-1 text-[13px] leading-relaxed text-[var(--crit-ins)] ${isActive ? "" : "line-clamp-5"}`}>
                                {repl.trim() ? repl : "(delete this span)"}
                              </p>
                              {applicableSuggestionIds.has(c.id) ? (
                                // Symmetric with the inline ✓/✗: Apply takes the proposed
                                // wording, Reject keeps the original span (both keep any
                                // surrounding discussion).
                                <div className="mt-1.5 flex items-center gap-1.5">
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
                              {(() => {
                                // Member of a suggestion group (#21): surface the whole-set
                                // controls — every member edit lands as ONE undoable apply.
                                // The LAYOUT of "see the set together" is chosen by groupView.
                                const g = suggestionGroupOf.get(c.id);
                                if (!g) return null;
                                return (
                                  <GroupSurface
                                    groupId={g.id}
                                    size={g.size}
                                    members={groupMembersOf.get(g.id) ?? []}
                                    view={groupView}
                                    isOpen={openControl === c.id}
                                    onToggle={() => setOpenControl(openControl === c.id ? null : c.id)}
                                    onGroupEdit={onGroupEdit}
                                  />
                                );
                              })()}
                            </div>
                          );
                        })()}
                      </div>
                    ))}

                    {replyingId === card.id ? (
                      <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
                        <textarea
                          autoFocus
                          rows={1}
                          value={replyDraft}
                          onChange={(e) => setReplyDraft(e.target.value)}
                          onKeyDown={(e) => handleCommentKey(e, () => submitReply(card, false), () => submitReply(card, card.kind === "comment"), () => { setReplyingId(null); setReplyDraft(""); })}
                          placeholder="Reply…  (⇧↵ for a new line)"
                          className="block max-h-40 w-full resize-none overflow-y-auto rounded-md border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-1.5 text-[13px] leading-relaxed text-[var(--ink)] outline-none [field-sizing:content] focus:border-[var(--accent)]"
                        />
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => submitReply(card, false)}
                            className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-[var(--panel)]"
                          >
                            Reply <span className="text-[10px] font-normal opacity-70">{MOD}↵</span>
                          </button>
                          {card.kind === "comment" ? (
                            <button
                              type="button"
                              onClick={() => submitReply(card, true)}
                              title="Reply and mark this thread seen"
                              className="flex items-center gap-1.5 rounded-md border border-[var(--line-strong)] px-2.5 py-1 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--line)]"
                            >
                              Reply &amp; seen <span className="text-[10px] font-normal text-[var(--faint)]">{MOD}⇧↵</span>
                            </button>
                          ) : null}
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
                            onFocusThread(card);
                          }}
                          className="text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"
                        >
                          Reply
                        </button>
                        {/* One-click hand-off: posts a "suggest edit" reply + marks the
                            thread seen, so it leaves your inbox and the agent picks it up.
                            (Comment cards only — a suggestion already IS an edit.) */}
                        {card.kind === "comment" ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSuggestEdit(card);
                            }}
                            title="Ask the agent for an edit here — posts “suggest edit” and marks the thread seen"
                            className="flex items-center gap-1 text-[12px] text-[var(--crit-comment)] hover:opacity-80"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                            </svg>
                            Suggest edit
                          </button>
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

// ── Suggestion-group "see the whole set" surfaces ─────────────────────────────
// A group member's card carries controls to review + apply the WHOLE group. Three
// layouts (comparison build, picked by ViewSettings.groupView): a popover that
// floats the member list off the chip, an inline expansion in the card, or a
// compact row (the Suggestions panel owns the list in that mode). All three list
// the same groupMembersOf data and call the same atomic onGroupEdit.

/** The members of a group as old → new rows, in document order. */
function GroupMembers({ members }: { members: SuggestionGroupMember[] }) {
  return (
    <ul className="space-y-1">
      {members.map((m, i) => (
        <li key={m.commentId} className="flex gap-1.5 text-[12px] leading-snug">
          <span className="shrink-0 tabular-nums text-[var(--faint)]">{i + 1}</span>
          <span className="min-w-0">
            {m.anchorText ? (
              <>
                <span className="text-[var(--crit-del)] line-through">{m.anchorText}</span>
                <span className="px-1 text-[var(--faint)]">→</span>
              </>
            ) : null}
            {m.isDelete ? (
              <span className="italic text-[var(--crit-del)]">(delete)</span>
            ) : (
              <span className="text-[var(--crit-ins)]">{m.replacement}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Apply-all / Reject-all for the whole group (one undoable edit). */
function GroupActions({
  groupId,
  size,
  onGroupEdit,
}: {
  groupId: string;
  size: number;
  onGroupEdit: (groupId: string, mode: "accept" | "reject") => void;
}) {
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onGroupEdit(groupId, "accept"); }}
        title={`Apply all ${size} edits in this group (one undo)`}
        className="rounded-md bg-[var(--crit-ins)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--panel)]"
      >
        Apply all {size}
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onGroupEdit(groupId, "reject"); }}
        title={`Reject all ${size} edits in this group (one undo)`}
        className="rounded-md border border-[var(--line-strong)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--crit-del)]"
      >
        Reject all
      </button>
    </div>
  );
}

function GroupSurface({
  groupId,
  size,
  members,
  view,
  isOpen,
  onToggle,
  onGroupEdit,
}: {
  groupId: string;
  size: number;
  members: SuggestionGroupMember[];
  view: GroupView;
  isOpen: boolean;
  onToggle: () => void;
  onGroupEdit: (groupId: string, mode: "accept" | "reject") => void;
}) {
  // Group tag, colour-matched to the card's spine so identity is unmistakable.
  const color = groupColor(groupId);
  const chip = (
    <span style={{ color }}>
      <span aria-hidden="true">⛓</span> {groupId} · {size} edits
    </span>
  );

  // Panel mode: the Suggestions overview owns the grouped list, so the card keeps
  // the compact inline controls (today's behaviour).
  if (view === "panel") {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 border-t border-[var(--line)] pt-1.5 text-[10px] text-[var(--muted)]">
        <span title={`Suggestion group “${groupId}” — listed in the Suggestions panel`}>{chip}</span>
        <GroupActions groupId={groupId} size={size} onGroupEdit={onGroupEdit} />
      </div>
    );
  }

  // Inline mode: a disclosure ▸/▾ expands the member list within the card.
  if (view === "inline") {
    return (
      <div
        data-group-ui
        className="mt-1.5 border-t border-[var(--line)] pt-1.5 text-[10px] text-[var(--muted)]"
      >
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          className="flex w-full items-center gap-1 text-left hover:text-[var(--ink)]"
          aria-expanded={isOpen}
        >
          <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span> {chip}
        </button>
        {isOpen ? (
          <div className="mt-1.5">
            <GroupMembers members={members} />
            <GroupActions groupId={groupId} size={size} onGroupEdit={onGroupEdit} />
          </div>
        ) : null}
      </div>
    );
  }

  // Popover mode (default): the chip opens a floating list off the card. Opens
  // UPWARD (the control sits at the card's bottom) so it overlays the visible card
  // body rather than spilling past the clipped column edge.
  return (
    <div
      data-group-ui
      className="relative mt-1.5 border-t border-[var(--line)] pt-1.5 text-[10px] text-[var(--muted)]"
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        className="flex items-center gap-1 hover:text-[var(--ink)]"
        aria-expanded={isOpen}
      >
        {chip} <span aria-hidden="true">▾</span>
      </button>
      {isOpen ? (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-full left-0 z-50 mb-1 w-72 rounded-xl border border-[var(--line-strong)] bg-[var(--panel)] p-2.5 text-[var(--ink)] shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-medium">{chip}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              aria-label="Close"
              className="rounded p-0.5 text-[var(--faint)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            </button>
          </div>
          <div className="max-h-60 overflow-y-auto pr-0.5">
            <GroupMembers members={members} />
          </div>
          <GroupActions groupId={groupId} size={size} onGroupEdit={onGroupEdit} />
        </div>
      ) : null}
    </div>
  );
}

export type { CommentSidebarProps };
