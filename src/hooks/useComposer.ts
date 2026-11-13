// ── Selection-anchored comment / suggestion composer ───────────────────────

import { useCallback, useRef, useState } from "react";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  scanTokens,
  formatComment,
  pointCommentInsert,
  widenToLiterals,
  wrappableSpan,
  commentKey,
  selectionAnnotationEdit,
} from "../lib/criticmarkup";
import type { SelectionAnnotationKind } from "../lib/criticmarkup";
import { isComment } from "../lib/types";
import type { ComposerAnchorRange } from "../editor/composerAnchor";

/** A click back into the document while the composer is open: an empty box has
 *  nothing to lose, so it closes and its blue anchor mark goes with it (the mark
 *  otherwise stayed painted over a selection that was gone). A box with text stays
 *  open, and the mark keeps showing the span the comment will attach to. */
export function closesOnDocumentPointer(draft: string): boolean {
  return draft.trim() === "";
}

/** Dispatch `spec`; if CodeMirror throws part-way through the update, put the view
 *  back on the state it had before and return the error. CodeMirror applies the new
 *  state before it redraws, so a redraw that throws (#53) used to leave a change in
 *  the state that was never drawn or saved, and every retry added another copy. */
export function dispatchOrRestore(view: EditorView, spec: TransactionSpec): Error | null {
  const before = view.state;
  try {
    view.dispatch(spec);
    return null;
  } catch (err) {
    view.setState(before);
    return err instanceof Error ? err : new Error(String(err));
  }
}

export type PostResult =
  | { ok: true; commentStart: number }
  /** `error` is null when there was nothing to post (no span for a suggestion). */
  | { ok: false; error: Error | null };

/** Post a comment or suggestion into the editor: a clean prose span is anchored by
 *  wrapping it in `{==span==}`; otherwise a point comment goes at `range.to` (or
 *  `fallbackAt`), clamped outside any markup so it can never nest. */
export function postToView(
  view: EditorView,
  opts: {
    author: string;
    text: string;
    kind: SelectionAnnotationKind;
    range: { from: number; to: number } | null;
    fallbackAt: number;
  },
): PostResult {
  const { author, text, kind } = opts;
  const content = view.state.doc.toString();
  const range = opts.range ? widenToLiterals(content, opts.range.from, opts.range.to) : null;
  if (range && wrappableSpan(content, range.from, range.to)) {
    const result = selectionAnnotationEdit(content, range.from, range.to, author, text, kind);
    if (!result.ok) return { ok: false, error: null };
    const marker = result.change.insert;
    const error = dispatchOrRestore(view, {
      changes: result.change,
      selection: { anchor: range.from + marker.length },
    });
    return error ? { ok: false, error } : { ok: true, commentStart: range.from + marker.indexOf("{>>") };
  }
  if (kind === "suggestion") return { ok: false, error: null };
  // Point comment: never inside markup or a code span; inside an existing anchor it
  // joins the end of that anchor's thread (#72).
  const raw = range ? range.to : opts.fallbackAt;
  const { from: at, insert } = pointCommentInsert(content, raw, formatComment(author, text));
  const error = dispatchOrRestore(view, {
    changes: { from: at, insert },
    selection: { anchor: at + insert.length },
  });
  return error ? { ok: false, error } : { ok: true, commentStart: at + insert.indexOf("{>>") };
}

export function useComposer(
  viewRef: React.MutableRefObject<EditorView | null>,
  author: string,
  setSeen: React.Dispatch<React.SetStateAction<Set<string>>>,
  setComposerAnchor: (range: ComposerAnchorRange | null) => void,
  onError: (message: string) => void,
) {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [composerKind, setComposerKind] = useState<SelectionAnnotationKind>("comment");
  // Whether the captured selection can anchor as a `{==span==}` (vs falling back to
  // a point comment) — surfaced in the composer so the fallback is never silent.
  const [composerAnchored, setComposerAnchored] = useState(true);
  const commentAnchor = useRef<number | null>(null);
  // Full selection range captured when the composer opens, so a comment can anchor to
  // the SPAN (wrapping it in `{==…==}`), not just a point — set in openComposer.
  const commentRange = useRef<{ from: number; to: number } | null>(null);

  const openSelectionComposer = useCallback((kind: SelectionAnnotationKind) => {
    const v = viewRef.current;
    if (!v) return;
    const sel = v.state.selection.main;
    if (sel.empty) return;
    commentAnchor.current = sel.to;
    const content = v.state.doc.toString();
    // A selection inside a code span anchors the WHOLE code span (#71); the blue
    // mark shows the widened range so the user sees what will be anchored.
    const range = widenToLiterals(content, sel.from, sel.to);
    commentRange.current = range;
    setComposerAnchor(range);
    // Tell the composer up front whether this selection anchors as a span or will
    // fall back to a point comment (selection cuts markup / crosses a paragraph).
    setComposerAnchored(wrappableSpan(content, range.from, range.to));
    setComposerKind(kind);
    setDraft("");
    setComposing(true);
  }, [viewRef, setComposerAnchor]);

  const openComposer = useCallback(() => openSelectionComposer("comment"), [openSelectionComposer]);
  const openSuggestionComposer = useCallback(
    () => openSelectionComposer("suggestion"),
    [openSelectionComposer],
  );

  const cancelComposer = useCallback(() => {
    setComposing(false);
    setDraft("");
    commentAnchor.current = null;
    commentRange.current = null;
    setComposerAnchor(null);
    viewRef.current?.focus();
  }, [viewRef, setComposerAnchor]);

  const postComment = useCallback(
    // markSeen (⌘⇧↵): post the comment and immediately mark it seen — the
    // "suggest edits" flow where you've said your piece and want it out of your
    // own inbox. Marks only the NEW comment (found by its post-insert offset), so
    // if it joined an existing thread the others stay open.
    (markSeen = false) => {
      const v = viewRef.current;
      const text = draft;
      if (!v || commentAnchor.current === null || !text.trim()) return;
      // Prefer the editor's LIVE selection (CodeMirror keeps it mapped through any
      // remote/agent edit that arrived while composing); fall back to the range captured
      // when the composer opened.
      const sel = v.state.selection.main;
      const picked = !sel.empty ? { from: sel.from, to: sel.to } : commentRange.current;
      const result = postToView(v, {
        author,
        text,
        kind: composerKind,
        range: picked,
        fallbackAt: commentAnchor.current,
      });
      if (!result.ok) {
        // A failed update is reported, never swallowed; the editor is back on the
        // state it had before, and the box keeps its text so nothing is lost.
        if (result.error) {
          console.error("ACM: posting the comment failed", result.error);
          onError(`Could not post the comment (${result.error.message}). Nothing was changed; your text is still in the box.`);
        }
        return;
      }
      const commentStart = result.commentStart;
      if (markSeen && composerKind === "comment") {
        const after = v.state.doc.toString();
        const fresh = scanTokens(after)
          .filter(isComment)
          .find((c) => c.from === commentStart);
        if (fresh) setSeen((p) => new Set(p).add(commentKey(fresh)));
      }
      setComposing(false);
      setDraft("");
      commentAnchor.current = null;
      commentRange.current = null;
      setComposerAnchor(null);
    },
    [draft, viewRef, author, setSeen, composerKind, setComposerAnchor, onError],
  );

  return {
    composing,
    draft,
    setDraft,
    composerKind,
    composerAnchored,
    openComposer,
    openSuggestionComposer,
    cancelComposer,
    postComment,
  };
}
