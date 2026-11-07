// ── Mobile comment sheet ──────────────────────────────────────────────────────
// On a phone the right-margin comment column is hidden (the reading area is too
// narrow to fit prose + a 320px column), so tapping a commented span had nowhere
// to show the comment. This is the mobile surface for that: a bottom sheet that
// slides up with the ACTIVE thread/suggestion while the anchored text stays
// visible above — the same pattern the Google Docs app uses.
//
// It deliberately does NOT reuse the desktop sidebar (which is an absolutely-
// positioned, transform-driven floating layout). It renders the same card DATA
// with the same handlers, but as a static, touch-tuned sheet: big tap targets,
// full comment text (no clamp), one thread at a time with prev/next-open nav so
// review still flows like the desktop inbox.

import { useEffect, useState } from "react";
import type { SidebarCard, CommentToken, SuggestionToken } from "../lib/types";
import { suggestionReplacement } from "../lib/criticmarkup";
import { authorColor } from "./authorColor";
import { handleCommentKey } from "./commentKeys";
import { standaloneAdditionTitle } from "./CommentSidebar";
import ReviewTextEditor, { closeReviewEditorAfterSuccessfulSave } from "./ReviewTextEditor";

interface MobileCommentSheetProps {
  /** The active card (thread or suggestion), or null when nothing is focused. */
  active: SidebarCard | null;
  /** Whether the active comment thread is currently in the seen set. */
  activeSeen: boolean;
  /** Open (unseen) comment count — shown in the header, mirrors the desktop pill. */
  unseenCount: number;
  richPreview: boolean;
  /** The next still-open card to advance to (null when none) — drives "Next". */
  nextOpen: SidebarCard | null;
  onClose: () => void;
  onGoTo: (card: SidebarCard) => void;
  onReply: (card: SidebarCard, text: string) => void;
  onReplyAndSeen: (card: SidebarCard, text: string) => void;
  onResolveThread: (card: SidebarCard) => void;
  onEditComment: (comment: CommentToken, body: string) => boolean;
  onEditSuggestion: (suggestion: CommentToken | SuggestionToken, proposal: string) => boolean;
  onSuggestEdit: (card: SidebarCard, proposal: string) => void;
  onToggleSeen: (card: SidebarCard) => void;
  onApplySuggestion: (comment: CommentToken) => void;
  onApplyAndResolveSuggestion: (comment: CommentToken) => void;
  onRejectSuggestionEdit: (comment: CommentToken) => void;
  applicableSuggestionIds: Set<string>;
  onAcceptSuggestion: (card: SidebarCard) => void;
  onRejectSuggestion: (card: SidebarCard) => void;
}

// Min 44px touch targets (Apple HIG) for every actionable control in the sheet.
const sheetBtn =
  "flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-[14px] font-medium";

export function seenToggleLabel(seen: boolean): "Mark done" | "Mark unseen" {
  return seen ? "Mark unseen" : "Mark done";
}

export function mobileReviewEntryLabel(
  visibleCount: number,
  unseenCount: number,
): string | null {
  if (visibleCount <= 0) return null;
  return unseenCount > 0 ? `${unseenCount} open` : `${visibleCount} shown`;
}

export default function MobileCommentSheet(props: MobileCommentSheetProps) {
  const {
    active,
    activeSeen,
    unseenCount,
    richPreview,
    nextOpen,
    onClose,
    onGoTo,
    onReply,
    onReplyAndSeen,
    onResolveThread,
    onEditComment,
    onEditSuggestion,
    onSuggestEdit,
    onToggleSeen,
    onApplySuggestion,
    onApplyAndResolveSuggestion,
    onRejectSuggestionEdit,
    applicableSuggestionIds,
    onAcceptSuggestion,
    onRejectSuggestion,
  } = props;

  const [draft, setDraft] = useState("");
  const [composeMode, setComposeMode] = useState<"reply" | "suggestion">("reply");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const open = active != null;
  const headAuthor = active?.comments[0]?.author ?? null;
  const activeSuggestionProposal =
    active?.kind !== "suggestion"
      ? null
      : active.suggestion.type === "insert"
        ? active.suggestion.inner
        : active.suggestion.type === "substitute"
          ? active.suggestion.newText
          : null;

  // Reset the reply draft whenever the focused thread changes (e.g. "Next ›"), so a
  // half-typed reply never bleeds onto a different thread. Keyed on the thread id,
  // not the card object — `active` is rebuilt on unrelated doc edits, and resetting
  // on those would wipe a reply mid-type.
  useEffect(() => {
    setDraft("");
    setComposeMode("reply");
    setEditingId(null);
    setEditDraft("");
  }, [active?.id]);

  function submit(markSeen: boolean) {
    const text = draft;
    if (text.trim() && active) {
      if (composeMode === "suggestion") onSuggestEdit(active, text);
      else (markSeen ? onReplyAndSeen : onReply)(active, text);
    }
    setDraft("");
    setComposeMode("reply");
  }

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-40 transition-transform duration-200 ease-out ${
        open ? "translate-y-0" : "pointer-events-none translate-y-full"
      }`}
      role="dialog"
      aria-label="Comment"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="mx-auto flex max-h-[62vh] w-full flex-col rounded-t-2xl border-t border-[var(--line)] bg-[var(--panel)] shadow-[0_-8px_30px_rgba(0,0,0,0.18)]">
        {/* Header: grab handle, who/what, open-count, close */}
        <div className="relative flex items-center gap-2 px-4 pb-2 pt-2.5">
          <span className="absolute left-1/2 top-1.5 h-1 w-9 -translate-x-1/2 rounded-full bg-[var(--line-strong)]" aria-hidden="true" />
          <span className="mt-1.5 flex items-center gap-1.5 truncate text-[13px] font-semibold">
            {active?.kind === "suggestion" ? (
              <span className="text-[var(--crit-comment)]">Suggested edit</span>
            ) : (
              <>
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: authorColor(headAuthor) }} />
                <span className="truncate" style={{ color: authorColor(headAuthor) }}>{headAuthor ?? "anonymous"}</span>
              </>
            )}
          </span>
          {unseenCount > 0 ? (
            <span className="mt-1.5 rounded-full bg-[var(--accent)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--panel)]">
              {unseenCount} open
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close comment"
            className="ml-auto mt-1 flex h-11 w-11 items-center justify-center rounded-full text-[var(--muted)] hover:bg-[var(--line)]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Body: full thread / suggestion (scrolls if long) */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-1">
          {active?.kind === "suggestion" ? (
            editingId === active.suggestion.id ? (
              <ReviewTextEditor
                value={editDraft}
                label="Edit suggestion"
                onChange={setEditDraft}
                onSave={() => closeReviewEditorAfterSuccessfulSave(
                  () => onEditSuggestion(active.suggestion, editDraft),
                  () => setEditingId(null),
                )}
                onCancel={() => setEditingId(null)}
                mobile
              />
            ) : (
              <SuggestionBlock
                card={active}
                richPreview={richPreview}
                onAccept={() => onAcceptSuggestion(active)}
                onReject={() => onRejectSuggestion(active)}
                onEdit={
                  activeSuggestionProposal === null
                    ? null
                    : () => {
                        setEditingId(active.suggestion.id);
                        setEditDraft(activeSuggestionProposal);
                      }
                }
              />
            )
          ) : null}

          {active?.comments.map((c, i) => (
            <div key={c.id} className={i > 0 || active.kind === "suggestion" ? "mt-3 border-t border-[var(--line)] pt-3" : ""}>
              {/* Reply rows (and suggestion-thread comments) get an author chip */}
              {active.kind === "suggestion" || i > 0 ? (
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: authorColor(c.author) }} />
                  <span className="truncate text-[12px] font-medium" style={{ color: authorColor(c.author) }}>{c.author ?? "anonymous"}</span>
                </div>
              ) : null}
              <div className="mb-1 flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    const replacement = suggestionReplacement(c.body);
                    setEditingId(c.id);
                    setEditDraft(replacement ?? c.body);
                  }}
                  className="min-h-11 rounded-lg px-3 text-[13px] font-medium text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
                >
                  {suggestionReplacement(c.body) === null ? "Edit comment" : "Edit suggestion"}
                </button>
              </div>
              {editingId === c.id ? (
                <ReviewTextEditor
                  value={editDraft}
                  label={suggestionReplacement(c.body) === null ? "Edit comment" : "Edit suggestion"}
                  onChange={setEditDraft}
                  onSave={() => closeReviewEditorAfterSuccessfulSave(
                    () => suggestionReplacement(c.body) === null
                      ? onEditComment(c, editDraft)
                      : onEditSuggestion(c, editDraft),
                    () => setEditingId(null),
                  )}
                  onCancel={() => setEditingId(null)}
                  mobile
                />
              ) : (
                <CommentBody
                  comment={c}
                  applicable={applicableSuggestionIds.has(c.id)}
                  onApply={() => onApplySuggestion(c)}
                  onApplyAndResolve={() => onApplyAndResolveSuggestion(c)}
                  onReject={() => onRejectSuggestionEdit(c)}
                />
              )}
            </div>
          ))}

          {/* Reply box — full-width, mobile keyboard friendly */}
          <div className="mt-3">
            <textarea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => handleCommentKey(e, () => submit(false), () => submit(true), onClose)}
              aria-label={composeMode === "suggestion" ? "Suggested replacement" : "Reply"}
              placeholder={composeMode === "suggestion" ? "Write the replacement text…" : "Reply…"}
              className="block max-h-40 w-full resize-none overflow-y-auto rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-3 py-2 text-base leading-relaxed text-[var(--ink)] outline-none [field-sizing:content] focus:border-[var(--accent)]"
            />
          </div>
        </div>

        {/* Action bar — big targets; the common review verbs */}
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] px-4 py-2.5">
          <button type="button" onClick={() => submit(false)} disabled={!draft.trim()} className={`${sheetBtn} bg-[var(--accent)] text-[var(--panel)] disabled:bg-transparent disabled:text-[var(--faint)] disabled:opacity-100 disabled:ring-1 disabled:ring-inset disabled:ring-[var(--line-strong)]`}>
            {composeMode === "suggestion" ? "Create suggestion" : "Reply"}
          </button>
          {active?.kind === "comment" ? (
            <>
              {composeMode === "suggestion" ? (
                <button type="button" onClick={() => { setComposeMode("reply"); setDraft(""); }} className={`${sheetBtn} border border-[var(--line-strong)] text-[var(--muted)]`}>
                  Cancel suggestion
                </button>
              ) : (
                <button type="button" onClick={() => { setComposeMode("suggestion"); setDraft(""); }} className={`${sheetBtn} border border-[var(--line-strong)] text-[var(--crit-comment)]`}>
                  Suggest edit
                </button>
              )}
              <button
                type="button"
                onClick={() => active && onToggleSeen(active)}
                aria-pressed={activeSeen}
                className={`${sheetBtn} border border-[var(--line-strong)] text-[var(--ink)]`}
              >
                {seenToggleLabel(activeSeen)}
              </button>
            </>
          ) : null}
          {active?.kind === "comment" ? (
            <button type="button" onClick={() => onResolveThread(active)} className={`${sheetBtn} ml-auto text-[var(--crit-del)]`}>
              Resolve
            </button>
          ) : null}
          {nextOpen ? (
            <button type="button" onClick={() => onGoTo(nextOpen)} className={`${sheetBtn} border border-[var(--line-strong)] text-[var(--ink)]`}>
              Next ›
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Suggestion card preview + Accept/Reject — the change shown like the desktop card. */
function SuggestionBlock({
  card,
  richPreview,
  onAccept,
  onReject,
  onEdit,
}: {
  card: Extract<SidebarCard, { kind: "suggestion" }>;
  richPreview: boolean;
  onAccept: () => void;
  onReject: () => void;
  onEdit: (() => void) | null;
}) {
  const s = card.suggestion;
  const badge = s.type === "substitute" ? "Replace" : s.type === "insert" ? "Add" : "Delete";
  return (
    <div className="pt-1">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-[var(--muted)]">{badge}</span>
        {onEdit ? (
          <button
            type="button"
            onClick={onEdit}
            className="min-h-11 rounded-lg px-3 text-[13px] font-medium text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
          >
            Edit suggestion
          </button>
        ) : null}
      </div>
      {s.type === "insert" && card.standalone && richPreview ? (
        <div className="mb-2">
          <p className="truncate text-[15px] font-medium leading-relaxed text-[var(--ink)]">
            {standaloneAdditionTitle(s.inner)}
          </p>
          <p className="mt-0.5 text-[12px] text-[var(--faint)]">Rendered in document</p>
        </div>
      ) : (
        <p className="mb-2 whitespace-pre-wrap text-[15px] leading-relaxed">
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
      <div className="flex gap-2">
        <button type="button" onClick={onAccept} className={`${sheetBtn} flex-1 bg-[var(--crit-ins)] text-[var(--panel)]`}>
          ✓ Accept
        </button>
        <button type="button" onClick={onReject} className={`${sheetBtn} flex-1 border border-[var(--line-strong)] text-[var(--crit-del)]`}>
          ✗ Reject
        </button>
      </div>
    </div>
  );
}

/** A single comment's body — plain text, or a structured SUGGEST: with Apply/Reject. */
function CommentBody({
  comment,
  applicable,
  onApply,
  onApplyAndResolve,
  onReject,
}: {
  comment: CommentToken;
  applicable: boolean;
  onApply: () => void;
  onApplyAndResolve: () => void;
  onReject: () => void;
}) {
  const repl = suggestionReplacement(comment.body);
  if (repl === null) {
    return <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--ink)]">{comment.body}</p>;
  }
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold text-[var(--crit-comment)]">Suggested edit</div>
      <p className="whitespace-pre-wrap rounded bg-[var(--crit-ins-bg)] px-2 py-1.5 text-[15px] leading-relaxed text-[var(--crit-ins)]">
        {repl.trim() ? repl : "(delete this span)"}
      </p>
      {applicable ? (
        <div className="mt-2 grid gap-2">
          <div className="flex gap-2">
            <button type="button" onClick={onApply} className={`${sheetBtn} flex-1 bg-[var(--crit-ins)] text-[var(--panel)]`}>
              Apply
            </button>
            <button type="button" onClick={onReject} className={`${sheetBtn} flex-1 border border-[var(--line-strong)] text-[var(--crit-del)]`}>
              Reject
            </button>
          </div>
          <button
            type="button"
            onClick={onApplyAndResolve}
            className={`${sheetBtn} w-full border border-[var(--crit-ins)] text-[var(--crit-ins)]`}
          >
            Apply &amp; resolve
          </button>
        </div>
      ) : (
        <p className="mt-1 text-[11px] italic text-[var(--faint)]">no anchored span to apply to</p>
      )}
    </div>
  );
}
