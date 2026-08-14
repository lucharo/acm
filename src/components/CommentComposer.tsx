import { useEffect, useRef } from "react";
import { MOD } from "../lib/platform";
import { handleCommentKey } from "./commentKeys";

interface CommentComposerProps {
  kind?: "comment" | "suggestion";
  draft: string;
  anchored: boolean;
  onDraftChange: (value: string) => void;
  onPost: () => void;
  onPostDone: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
  mobile?: boolean;
}

export default function CommentComposer({
  kind = "comment",
  draft,
  anchored,
  onDraftChange,
  onPost,
  onPostDone,
  onCancel,
  autoFocus = true,
  mobile = false,
}: CommentComposerProps) {
  const suggestion = kind === "suggestion";
  const canPost = draft.trim().length > 0 && (!suggestion || anchored);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  return (
    <section className="rounded-xl border border-[var(--line-strong)] bg-[var(--panel)] p-3 shadow-[0_4px_18px_rgba(0,0,0,0.12)]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ink)]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--crit-comment)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {suggestion ? "Suggest replacement" : "Comment on selection"}
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label={suggestion ? "Cancel suggestion" : "Cancel comment"}
          title="Cancel"
          className={mobile
            ? "flex h-11 w-11 items-center justify-center rounded-lg text-[var(--faint)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
            : "rounded p-1 text-[var(--faint)] hover:bg-[var(--line)] hover:text-[var(--ink)]"}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <textarea
        ref={textareaRef}
        autoFocus={autoFocus}
        rows={3}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => handleCommentKey(event, onPost, onPostDone, onCancel)}
        aria-label={suggestion ? "Suggested replacement" : "Comment on selection"}
        placeholder={suggestion ? "Write the replacement text…" : "Write a comment…  Shift-Enter for a new line"}
        className={`block max-h-52 min-h-20 w-full resize-y rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2.5 py-2 leading-relaxed text-[var(--ink)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] ${mobile ? "text-base" : "text-[13px]"}`}
      />
      {!anchored ? (
        <p className="mt-1.5 text-[10px] leading-snug text-[var(--muted)]">
          {suggestion
            ? "A suggestion must stay within one plain-text block. Adjust the selection to continue."
            : "This selection crosses markup or a paragraph, so the comment will attach at its end."}
        </p>
      ) : null}
      <div className={mobile ? "mt-2.5 grid grid-cols-2 gap-2" : "mt-2.5 flex flex-wrap items-center justify-end gap-1.5"}>
        {!suggestion ? <button
          type="button"
          onClick={onPostDone}
          disabled={!canPost}
          title="Post and mark this comment done"
          className={mobile
            ? "min-h-11 rounded-lg border border-[var(--line-strong)] px-3 text-sm font-medium text-[var(--ink)] enabled:hover:bg-[var(--line)] disabled:cursor-not-allowed disabled:opacity-40"
            : "rounded-md border border-[var(--line-strong)] px-2 py-1 text-[11px] font-medium text-[var(--ink)] enabled:hover:bg-[var(--line)] disabled:cursor-not-allowed disabled:opacity-40"}
        >
          Post &amp; done {mobile ? null : <span className="text-[10px] font-normal text-[var(--faint)]">{MOD}⇧↵</span>}
        </button> : null}
        <button
          type="button"
          onClick={onPost}
          disabled={!canPost}
          className={mobile
            ? "min-h-11 rounded-lg bg-[var(--accent)] px-3 text-sm font-medium text-[var(--panel)] disabled:cursor-not-allowed disabled:bg-transparent disabled:text-[var(--faint)] disabled:opacity-100 disabled:ring-1 disabled:ring-inset disabled:ring-[var(--line-strong)]"
            : "rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--panel)] disabled:cursor-not-allowed disabled:opacity-40"}
        >
          {suggestion ? "Create suggestion" : "Post"} {mobile ? null : <span className="text-[10px] font-normal opacity-70">{MOD}↵</span>}
        </button>
      </div>
    </section>
  );
}

export type { CommentComposerProps };
