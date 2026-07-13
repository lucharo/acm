// ── The comment composer (header textarea) + one-click "Suggest edit" ─────────
// All composer state and the three actions that write comments into the buffer:
// open (capture the selection + disclose anchor/point), post (span-anchored when
// wrappable, else clamped point comment; optional mark-seen), and the canned
// suggest-edit hand-off. Extracted whole from Workspace — the editor view ref,
// author name and seen-setter arrive as inputs.

import { useCallback, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import {
  scanTokens,
  formatComment,
  clampAnchorOutsideComments,
  wrappableSpan,
  commentKey,
} from "../lib/criticmarkup";
import { isComment } from "../lib/types";

// Canned body for the one-click "Suggest edit" hand-off action (also matched by
// replyAndSeen in App — the one shared definition).
export const SUGGEST_EDIT_TEXT = "suggest edit";

export function useComposer(
  viewRef: React.MutableRefObject<EditorView | null>,
  author: string,
  setSeen: React.Dispatch<React.SetStateAction<Set<string>>>,
) {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  // Whether the captured selection can anchor as a `{==span==}` (vs falling back to
  // a point comment) — surfaced in the composer so the fallback is never silent.
  const [composerAnchored, setComposerAnchored] = useState(true);
  const commentAnchor = useRef<number | null>(null);
  // Full selection range captured when the composer opens, so a comment can anchor to
  // the SPAN (wrapping it in `{==…==}`), not just a point — set in openComposer.
  const commentRange = useRef<{ from: number; to: number } | null>(null);

  // ── Add a comment from the current selection ──────────────────────────────────
  const openComposer = useCallback(() => {
    const v = viewRef.current;
    if (!v) return;
    const sel = v.state.selection.main;
    if (sel.empty) return;
    commentAnchor.current = sel.to;
    commentRange.current = { from: sel.from, to: sel.to };
    // Tell the composer up front whether this selection anchors as a span or will
    // fall back to a point comment (selection cuts markup / crosses a paragraph).
    setComposerAnchored(wrappableSpan(v.state.doc.toString(), sel.from, sel.to));
    setDraft("");
    setComposing(true);
  }, [viewRef]);

  const postComment = useCallback(
    // markSeen (⌘⇧↵): post the comment and immediately mark it seen — the
    // "suggest edits" flow where you've said your piece and want it out of your
    // own inbox. Marks only the NEW comment (found by its post-insert offset), so
    // if it joined an existing thread the others stay open.
    (markSeen = false) => {
      const v = viewRef.current;
      const text = draft.trim();
      if (!v || commentAnchor.current === null || !text) {
        setComposing(false);
        return;
      }
      const content = v.state.doc.toString();
      // Prefer the editor's LIVE selection (CodeMirror keeps it mapped through any
      // remote/agent edit that arrived while composing); fall back to the range captured
      // when the composer opened. A clean prose span → anchor the comment to it by
      // wrapping `{==span==}`; otherwise a point comment at the selection end (clamped
      // outside any comment so we can never nest).
      const sel = v.state.selection.main;
      const range = !sel.empty ? { from: sel.from, to: sel.to } : commentRange.current;

      let commentStart: number;
      if (range && wrappableSpan(content, range.from, range.to)) {
        const open = `{==${content.slice(range.from, range.to)}==}`;
        const marker = open + formatComment(author, text);
        v.dispatch({ changes: { from: range.from, to: range.to, insert: marker } });
        commentStart = range.from + open.length; // the `{>>` lands right after the highlight
      } else {
        const raw = range ? range.to : commentAnchor.current!;
        const at = clampAnchorOutsideComments(content, Math.max(0, Math.min(raw, content.length)));
        const prev = at > 0 ? content.slice(at - 1, at) : "";
        const lead = at > 0 && !/\s/.test(prev) ? " " : "";
        v.dispatch({ changes: { from: at, insert: lead + formatComment(author, text) } });
        commentStart = at + lead.length;
      }
      if (markSeen) {
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
    },
    [draft, viewRef, author, setSeen],
  );

  // One-click "Suggest edit" on the current selection: anchor a canned "suggest edit"
  // comment at the selection + mark it seen, handing the span to the agent — no
  // composer, no typing. Mirrors postComment's anchor/clamp logic.
  const suggestEditOnSelection = useCallback(() => {
    const v = viewRef.current;
    if (!v) return;
    const sel = v.state.selection.main;
    if (sel.empty) return;
    const content = v.state.doc.toString();
    const at = clampAnchorOutsideComments(content, Math.max(0, Math.min(sel.to, content.length)));
    const prev = at > 0 ? content.slice(at - 1, at) : "";
    const lead = at > 0 && !/\s/.test(prev) ? " " : "";
    v.dispatch({ changes: { from: at, insert: lead + formatComment(author, SUGGEST_EDIT_TEXT) } });
    const fresh = scanTokens(v.state.doc.toString())
      .filter(isComment)
      .find((c) => c.from === at + lead.length);
    if (fresh) setSeen((p) => new Set(p).add(commentKey(fresh)));
  }, [viewRef, author, setSeen]);

  return {
    composing,
    setComposing,
    draft,
    setDraft,
    composerAnchored,
    openComposer,
    postComment,
    suggestEditOnSelection,
  };
}
