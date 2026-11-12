// ── Selection-anchored comment / suggestion composer ───────────────────────

import { useCallback, useRef, useState } from "react";
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

export function useComposer(
  viewRef: React.MutableRefObject<EditorView | null>,
  author: string,
  setSeen: React.Dispatch<React.SetStateAction<Set<string>>>,
  setComposerAnchor: (range: ComposerAnchorRange | null) => void,
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
      const content = v.state.doc.toString();
      // Prefer the editor's LIVE selection (CodeMirror keeps it mapped through any
      // remote/agent edit that arrived while composing); fall back to the range captured
      // when the composer opened. A clean prose span → anchor the comment to it by
      // wrapping `{==span==}`; otherwise a point comment at the selection end (clamped
      // outside any comment so we can never nest).
      const sel = v.state.selection.main;
      const picked = !sel.empty ? { from: sel.from, to: sel.to } : commentRange.current;
      const range = picked ? widenToLiterals(content, picked.from, picked.to) : null;

      let commentStart: number;
      if (range && wrappableSpan(content, range.from, range.to)) {
        const result = selectionAnnotationEdit(
          content,
          range.from,
          range.to,
          author,
          text,
          composerKind,
        );
        if (!result.ok) return;
        const marker = result.change.insert;
        v.dispatch({
          changes: result.change,
          selection: { anchor: range.from + marker.length },
        });
        commentStart = range.from + marker.indexOf("{>>");
      } else {
        if (composerKind === "suggestion") return;
        // Point comment: never inside markup or a code span; inside an existing
        // anchor it joins the end of that anchor's thread (#72).
        const raw = range ? range.to : commentAnchor.current!;
        const { from: at, insert } = pointCommentInsert(content, raw, formatComment(author, text));
        v.dispatch({
          changes: { from: at, insert },
          selection: { anchor: at + insert.length },
        });
        commentStart = at + insert.indexOf("{>>");
      }
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
    [draft, viewRef, author, setSeen, composerKind, setComposerAnchor],
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
