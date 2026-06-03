// Per-issue heal review — the trust unlock for auto-healing.
//
// Instead of a blind "Heal all", step through each broken (comment-in-comment)
// issue and show EXACTLY what the fix will do: which word gets rejoined, and which
// comment(s) get pulled out as their own. Heal one at a time (each is its own
// undoable edit), skip, or jump to it in the doc. "Heal all" stays as an escape
// hatch. Non-auto-fixable cases (broken close markers) are surfaced honestly with a
// jump, never silently.

import { useEffect, useState } from "react";
import { nestedCommentDetail } from "../lib/criticmarkup";
import { authorColor } from "./authorColor";

interface HealReviewProps {
  content: string;
  /** Auto-healable (nested) issues, in document order: { from, preview }. */
  issues: { from: number; preview: string }[];
  /** ALL malformed comments (nested + broken-close + dangling). */
  brokenTotal: number;
  onHealOne: (from: number) => void;
  onHealAll: () => void;
  onJump: (from: number) => void;
  /** Jump to the first non-auto-fixable issue (broken close). */
  onJumpManual: () => void;
  onClose: () => void;
}

export default function HealReview(props: HealReviewProps) {
  const { content, issues, brokenTotal, onHealOne, onHealAll, onJump, onJumpManual, onClose } = props;
  const [cursor, setCursor] = useState(0);

  // Issues shrink as you heal; keep the cursor in range.
  useEffect(() => {
    if (cursor >= issues.length && issues.length > 0) setCursor(issues.length - 1);
  }, [issues.length, cursor]);

  const manualCount = Math.max(0, brokenTotal - issues.length);
  const issue = issues[Math.min(cursor, issues.length - 1)];
  const detail = issue ? nestedCommentDetail(content, issue.from) : null;
  const line = issue ? content.slice(0, issue.from).split("\n").length : 0;

  return (
    <div className="fixed bottom-3 right-3 z-40 w-[24rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-[var(--warn)] bg-[var(--panel)] p-3.5 text-[13px] shadow-2xl">
      {/* Header */}
      <div className="mb-2.5 flex items-center gap-2">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="font-semibold text-[var(--ink)]">Review comments that can’t display</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded p-1 text-[var(--faint)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
          aria-label="Close review"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {issues.length === 0 ? (
        <div className="py-2 text-[var(--muted)]">
          {manualCount > 0 ? (
            <>
              No auto-fixable issues left. <span className="font-medium text-[var(--warn)]">{manualCount}</span> need a manual fix (a broken{" "}
              <code className="text-[12px]">{"‹‹}"}</code> close).{" "}
              <button type="button" onClick={onJumpManual} className="font-medium text-[var(--accent)] underline">
                Jump to the first
              </button>
              .
            </>
          ) : (
            <span className="text-[var(--crit-ins)]">✓ All comments display correctly.</span>
          )}
        </div>
      ) : (
        <>
          <div className="mb-1.5 text-[11px] text-[var(--faint)]">
            Issue {Math.min(cursor, issues.length - 1) + 1} of {issues.length} · line {line}
          </div>

          {/* The host comment + what's wrongly inside it */}
          {detail ? (
            <>
              <div className="mb-2 rounded-md bg-[var(--bg)] px-2.5 py-2">
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: authorColor(detail.outerAuthor) }} />
                  <span className="truncate text-[12px] font-medium" style={{ color: authorColor(detail.outerAuthor) }}>
                    {detail.outerAuthor ?? "anonymous"}
                  </span>
                </div>
                <p className="line-clamp-2 text-[12px] leading-snug text-[var(--muted)]">{detail.outerPreview}…</p>
              </div>

              {/* Focused before → after of the split word */}
              {detail.splitWord ? (
                <div className="mb-2 text-[12px] leading-relaxed">
                  <span className="text-[var(--faint)]">rejoins </span>
                  <span className="rounded bg-[var(--crit-del-bg)] px-1 text-[var(--crit-del)] line-through">
                    {detail.splitWord.before}|{detail.splitWord.after}
                  </span>
                  <span className="px-1 text-[var(--faint)]">→</span>
                  <span className="rounded bg-[var(--crit-ins-bg)] px-1 font-medium text-[var(--crit-ins)]">
                    {detail.splitWord.before}
                    {detail.splitWord.after}
                  </span>
                </div>
              ) : null}

              {/* The comment(s) pulled out as their own */}
              <div className="mb-3 text-[12px] leading-relaxed">
                <span className="text-[var(--faint)]">pulls out {detail.inners.length === 1 ? "this comment" : "these comments"} as {detail.inners.length === 1 ? "its own" : "their own"}: </span>
                <span className="flex flex-col gap-1 pt-1">
                  {detail.inners.map((inner, k) => (
                    <span key={k} className="flex items-start gap-1.5">
                      <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: authorColor(inner.author) }} />
                      <span className="text-[var(--ink)]">
                        <span className="font-medium" style={{ color: authorColor(inner.author) }}>{inner.author ?? "anonymous"}</span>
                        {inner.preview ? `: ${inner.preview}` : ""}
                      </span>
                    </span>
                  ))}
                </span>
              </div>
            </>
          ) : null}

          {/* Per-issue actions */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => issue && onHealOne(issue.from)}
              className="flex items-center gap-1.5 rounded-md bg-[var(--crit-ins)] px-2.5 py-1 text-[12px] font-medium text-[var(--panel)]"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Heal this
            </button>
            <button
              type="button"
              onClick={() => issue && onJump(issue.from)}
              className="rounded-md border border-[var(--line-strong)] px-2.5 py-1 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--line)]"
            >
              Jump
            </button>
            <button
              type="button"
              onClick={() => setCursor((c) => (c + 1) % issues.length)}
              className="rounded-md px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--line)]"
            >
              Skip →
            </button>
          </div>
        </>
      )}

      {/* Footer: escape hatch + honesty about non-fixable */}
      <div className="mt-3 flex items-center gap-3 border-t border-[var(--line)] pt-2.5 text-[11px]">
        {issues.length > 0 ? (
          <button type="button" onClick={onHealAll} className="font-medium text-[var(--muted)] hover:text-[var(--ink)]">
            Heal all {issues.length}
          </button>
        ) : null}
        {manualCount > 0 && issues.length > 0 ? (
          <button type="button" onClick={onJumpManual} className="ml-auto text-[var(--warn)] hover:underline">
            {manualCount} need you →
          </button>
        ) : null}
      </div>
    </div>
  );
}
