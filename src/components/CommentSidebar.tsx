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
import type { MouseEvent as ReactMouseEvent } from "react";
import type { EditorView } from "@codemirror/view";
import type { CommentThread } from "../lib/types";
import { authorColor } from "./authorColor";

interface CommentSidebarProps {
  view: EditorView | null;
  threads: CommentThread[];
  activeId: string | null;
  /** Thread ids whose every comment is marked "seen". */
  seenIds: Set<string>;
  /** Hide seen threads entirely (declutter) vs. just dim them. */
  hideSeen: boolean;
  onToggleSeen: (thread: CommentThread) => void;
  repositionKey: number;
  /** Nonce-tagged request (from a right-click "Reply") to open a thread's reply box. */
  replyTarget?: { id: string; n: number } | null;
  onResolveThread: (thread: CommentThread) => void;
  onReply: (thread: CommentThread, text: string) => void;
  onFocusThread: (thread: CommentThread) => void;
  onCardContextMenu?: (thread: CommentThread, e: ReactMouseEvent) => void;
  /** Lowest card's bottom in editor-content space — App uses it as the editor's
   *  min content height so cards stacked below the last line stay scroll-reachable. */
  onContentExtent?: (px: number) => void;
}

const BUBBLE_GAP = 16;
const CARD_LEFT = 18; // px from the column's left edge to the card

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
    threads,
    activeId,
    seenIds,
    hideSeen,
    onToggleSeen,
    repositionKey,
    replyTarget,
    onResolveThread,
    onReply,
    onFocusThread,
    onCardContextMenu,
    onContentExtent,
  } = props;

  // Threads actually shown: drop seen ones when "hide seen" is on. Used for BOTH
  // layout and render so hidden cards take no vertical space.
  const visibleThreads = hideSeen ? threads.filter((t) => !seenIds.has(t.id)) : threads;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardsTrackRef = useRef<HTMLDivElement | null>(null);
  const connTrackRef = useRef<SVGSVGElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const layoutRef = useRef<Map<string, CardLayout>>(new Map());
  const [layout, setLayout] = useState<Map<string, CardLayout>>(() => new Map());
  // X (sidebar-local) of the page's right edge — where connectors originate.
  // Negative when the page sits left of this column (the usual case).
  const [originX, setOriginX] = useState(0);

  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");

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
        const padTop = view0.documentPadding.top;
        const docTop = contentRect.top + view0.scrollDOM.scrollTop - cRect.top + padTop;
        const measured = visibleThreads.map((t) => ({
          id: t.id,
          anchorY: docTop + view0.lineBlockAt(t.from).top,
          height: cardRefs.current.get(t.id)?.offsetHeight ?? 0,
        }));
        return { measured, origin: contentRect.right - cRect.left, docTop, padTop };
      },
      write({ measured, origin, docTop, padTop }) {
        const sorted = [...measured].sort((a, b) => a.anchorY - b.anchorY);
        const next = new Map<string, CardLayout>();
        const h = (m: (typeof sorted)[number]) => m.height || 80;

        // MAGNETIC focus: when a thread is active, pin its card AT its anchor line
        // and stack the rest away from it (downward below, upward above), instead of
        // pure greedy top-down stacking. Stacked comments otherwise push a card far
        // from the text it references; this snaps the one you're reading back to it.
        const activeThread = activeId
          ? visibleThreads.find((t) => t.comments.some((c) => c.id === activeId))
          : null;
        const activeIdx = activeThread
          ? sorted.findIndex((m) => m.id === activeThread.id)
          : -1;

        if (activeIdx >= 0) {
          const a = sorted[activeIdx];
          next.set(a.id, { anchorY: a.anchorY, cardY: a.anchorY });
          // Below the active card: greedy downward from it.
          let prevBottom = a.anchorY + h(a);
          for (let i = activeIdx + 1; i < sorted.length; i++) {
            const m = sorted[i];
            const cardY = Math.max(m.anchorY, prevBottom + BUBBLE_GAP);
            next.set(m.id, { anchorY: m.anchorY, cardY });
            prevBottom = cardY + h(m);
          }
          // Above the active card: greedy upward from it (cards yield upward).
          let nextTop = a.anchorY;
          for (let i = activeIdx - 1; i >= 0; i--) {
            const m = sorted[i];
            const cardY = Math.min(m.anchorY, nextTop - BUBBLE_GAP - h(m));
            next.set(m.id, { anchorY: m.anchorY, cardY });
            nextTop = cardY;
          }
        } else {
          let prevBottom = -Infinity;
          for (const m of sorted) {
            const cardY = Math.max(m.anchorY, prevBottom + BUBBLE_GAP);
            next.set(m.id, { anchorY: m.anchorY, cardY });
            prevBottom = cardY + h(m);
          }
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
        // The lowest card bottom in editor-content space (line 0 at content padTop),
        // so the editor can grow tall enough to scroll it into view.
        if (onContentExtent && sorted.length > 0) {
          onContentExtent(Math.ceil(padTop + (maxBottom - docTop) + 64));
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
  }, [view, threads, repositionKey, replyingId, activeId, hideSeen, seenIds]);

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

  const ordered = [...visibleThreads].sort((a, b) => a.from - b.from);
  const active = ordered.find((t) => t.comments.some((c) => c.id === activeId)) ?? null;
  const activeLayout = active ? layout.get(active.id) : null;

  function submitReply(thread: CommentThread) {
    const text = replyDraft.trim();
    if (text) onReply(thread, text);
    setReplyingId(null);
    setReplyDraft("");
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {ordered.length === 0 ? (
        <div className="px-3 pt-5 text-xs italic text-[var(--faint)]">No comments.</div>
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
                  const stroke = authorColor(active.comments[0].author);
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
              {ordered.map((thread) => {
                const l = layout.get(thread.id);
                const isActive = thread.comments.some((c) => c.id === activeId);
                const isSeen = seenIds.has(thread.id);
                return (
                  <div
                    key={thread.id}
                    ref={(el) => {
                      if (el) cardRefs.current.set(thread.id, el);
                      else cardRefs.current.delete(thread.id);
                    }}
                    onClick={() => onFocusThread(thread)}
                    onContextMenu={(e) => onCardContextMenu?.(thread, e)}
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
                      // Seen (but not currently focused) cards dim to declutter.
                      opacity: l ? (isSeen && !isActive ? 0.45 : 1) : 0,
                    }}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleSeen(thread);
                      }}
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
                      onClick={(e) => {
                        e.stopPropagation();
                        onResolveThread(thread);
                      }}
                      title="Resolve thread"
                      className="absolute right-2 top-2.5 rounded p-1 text-[var(--faint)] opacity-0 transition-opacity hover:bg-[var(--line)] hover:text-[var(--ink)] group-hover:opacity-100"
                      aria-label="Resolve thread"
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                        <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>

                    {thread.comments.map((c, i) => (
                      <div key={c.id} className={i > 0 ? "mt-2.5 border-t border-[var(--line)] pt-2.5" : ""}>
                        <div className="mb-1 flex items-center gap-1.5 pr-6">
                          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: authorColor(c.author) }} />
                          <span className="truncate text-[12px] font-medium" style={{ color: authorColor(c.author) }}>
                            {c.author ?? "anonymous"}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink)]">{c.body}</p>
                      </div>
                    ))}

                    {replyingId === thread.id ? (
                      <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          autoFocus
                          value={replyDraft}
                          onChange={(e) => setReplyDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              submitReply(thread);
                            } else if (e.key === "Escape") {
                              setReplyingId(null);
                              setReplyDraft("");
                            }
                          }}
                          placeholder="Reply…"
                          className="w-full rounded-md border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setReplyingId(thread.id);
                          setReplyDraft("");
                          onFocusThread(thread);
                        }}
                        className="mt-2 text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"
                      >
                        Reply
                      </button>
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

export type { CommentSidebarProps };
