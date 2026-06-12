// ── ACM workspace ─────────────────────────────────────────────────────────────
// Wires the four modules into one window:
//   • useDocSync  — initial snapshot + WebSocket pushes + debounced version-checked save
//   • useCodeMirror — the editor (buffer = source of truth); local edits flow OUT
//     via onDocChanged → save; remote/agent edits flow IN via applyRemote
//   • CommentSidebar / NavPanel — presentational, driven by tokens scanned from the doc
//
// The editor BUFFER is ground truth; `doc` state here mirrors it so the sidebar/nav
// can scan tokens. Accept/reject/resolve are plain ranged edits over the buffer
// (using the shared lib grammar), which then debounce-save to the file.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";

import { useDocSync } from "./client/useDocSync";
import type { SaveState } from "./client/useDocSync";
import { useCodeMirror } from "./editor/useCodeMirror";
import type { CritCallbacks } from "./editor/criticMarkupView";
import CommentSidebar, { MOD } from "./components/CommentSidebar";
import HealReview from "./components/HealReview";
import Toc from "./components/Toc";
import NavPanel from "./components/NavPanel";
import Header from "./components/Header";
import ContextMenu from "./components/ContextMenu";
import type { MenuItem, MenuState } from "./components/ContextMenu";
import type { ViewSettings } from "./lib/viewSettings";
import { useViewSettings, useSeenState, commentKey } from "./hooks/useConfigState";
import { useDocDerived, useSeenDerived } from "./hooks/useDocDerived";
import { useComposer } from "./hooks/useComposer";
import CommandPalette from "./components/CommandPalette";
import type { PaletteAction } from "./components/CommandPalette";
import {
  scanTokens,
  applySuggestion,
  formatComment,
  groupThreads,
  groupCards,
  countWords,
  resolveAnchorEdit,
  healDocument,
  healOneNestedComment,
  nestedCommentIssues,
  validateMarkup,
  clampAnchorOutsideComments,
  suggestionThreadEdit,
  inlineSuggestions,
  wrappableSpan,
  hardWrap,
  suggestionGroupEdits,
} from "./lib/criticmarkup";
import { isComment, isSuggestion } from "./lib/types";
import type {
  CritToken,
  SuggestionToken,
  CommentToken,
  CommentThread,
  FilterMode,
} from "./lib/types";


// Canned body for the one-click "Suggest edit" hand-off action.
const SUGGEST_EDIT_TEXT = "suggest edit";

// Minimal single-range change between two strings (shared prefix/suffix trimmed), so
// a rewrite dispatches as a tight ranged change instead of a whole-doc replace —
// keeps undo granular and avoids a scroll jump.
function dispatchableDiff(before: string, after: string): { from: number; to: number; insert: string } {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return { from: p, to: before.length - s, insert: after.slice(p, after.length - s) };
}

export default function App() {
  // Remote updates (WS push / reconnect resync / 409) are forwarded into the
  // Workspace once it has registered its handler. An update can arrive in the gap
  // between the initial GET (which mounts Workspace) and Workspace's effect — if
  // the file changed in that window the snapshots differ, so we must NOT drop it.
  // Buffer the latest pending update; Workspace drains it on registration.
  const remoteRef = useRef<((content: string, version: number) => void) | null>(
    null,
  );
  const pendingRemote = useRef<{ content: string; version: number } | null>(null);
  const sync = useDocSync({
    onRemoteUpdate: (content, version) => {
      if (remoteRef.current) remoteRef.current(content, version);
      else pendingRemote.current = { content, version };
    },
  });

  // View settings live at the App level so theme/font apply to the loading
  // screen too (state + persistence in useConfigState).
  const { settings, onChangeSettings } = useViewSettings();


  if (sync.initialDoc === null) {
    return <Loading connected={sync.connected} />;
  }
  return (
    <Workspace
      initialDoc={sync.initialDoc}
      save={sync.save}
      flushNow={sync.flushNow}
      connected={sync.connected}
      saveState={sync.saveState}
      lastSavedAt={sync.lastSavedAt}
      remoteRef={remoteRef}
      pendingRemote={pendingRemote}
      settings={settings}
      onChangeSettings={onChangeSettings}
    />
  );
}

function Loading({ connected }: { connected: boolean }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
      Loading document{connected ? "" : " (connecting…)"}…
    </div>
  );
}

interface WorkspaceProps {
  initialDoc: string;
  save: (content: string) => void;
  flushNow: () => void;
  connected: boolean;
  saveState: SaveState;
  lastSavedAt: number | null;
  remoteRef: React.MutableRefObject<
    ((content: string, version: number) => void) | null
  >;
  pendingRemote: React.MutableRefObject<{ content: string; version: number } | null>;
  settings: ViewSettings;
  onChangeSettings: (patch: Partial<ViewSettings>) => void;
}

function Workspace({
  initialDoc,
  save,
  flushNow,
  connected,
  saveState,
  lastSavedAt,
  remoteRef,
  pendingRemote,
  settings,
  onChangeSettings,
}: WorkspaceProps) {
  // `doc` mirrors the editor buffer so the sidebar/nav can scan tokens.
  const [doc, setDoc] = useState(initialDoc);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [repositionKey, setRepositionKey] = useState(0);
  const [view, setView] = useState<EditorView | null>(null);
  // The overview panel is hidden by default ("less is more"); a header toggle / the
  // settings menu reveals it. Comments live in the right margin; suggestions also
  // carry inline ✓/✗, so the default editor+margin view loses nothing.
  const [navOpen, setNavOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [tocActiveFrom, setTocActiveFrom] = useState<number | null>(null);
  // Extra scroll reach (px of scroller bottom padding) so cards stacked below the
  // last line stay reachable — reported by the sidebar as overflow past the last
  // text line. 0 = no overflow. Padding, not content min-height: the page sheet
  // must never stretch past the prose (the old approach left a huge white gap).
  const [scrollReach, setScrollReach] = useState(0);

  // Hide the right-margin comment column when the reading area is too narrow to
  // fit both the prose and the ~320px comments — below this the editor is
  // unreadably cramped. The inline comment dots and the overview panel stay
  // available, so comments remain reachable. Driven by the reading area's actual
  // width (a ResizeObserver), so it adapts to the window AND the overview panel.
  const readingRef = useRef<HTMLDivElement | null>(null);
  const [commentsVisible, setCommentsVisible] = useState(true);
  useEffect(() => {
    const el = readingRef.current;
    if (!el) return;
    const COMMENTS_MIN_WIDTH = 800;
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1].contentRect.width;
      setCommentsVisible(w >= COMMENTS_MIN_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  // Everything derived from the doc (tokens → threads/cards → suggestions →
  // markup health) — see hooks/useDocDerived.
  const {
    tokens,
    wordCount,
    headings,
    threads,
    cards,
    commentCards,
    inlineSuggestionList,
    applicableSuggestionIds,
    healIssues,
    diagnostics,
    fixableCount,
    suggestionGroupOf,
  } = useDocDerived(doc);

  // "Seen" tracking — content-keyed, non-destructive (state + persistence in
  // useConfigState).
  const { seen, setSeen } = useSeenState();
  const { seenThreadIds, unseenCount } = useSeenDerived(commentCards, seen);
  // Mutation callbacks invoked by editor widgets. They need the live view, which
  // useCodeMirror returns below — so widgets call through a stable proxy that
  // reads the freshest handlers from this ref. The proxy identity never changes,
  // so the editor's callbacks facet is configured exactly once.
  const handlersRef = useRef<CritCallbacks>({
    onAccept: () => {},
    onReject: () => {},
    onCommentClick: () => {},
    onAcceptSuggestion: () => {},
    onRejectSuggestion: () => {},
  });
  const stableCallbacks = useMemo<CritCallbacks>(
    () => ({
      onAccept: (from, to) => handlersRef.current.onAccept(from, to),
      onReject: (from, to) => handlersRef.current.onReject(from, to),
      onCommentClick: (from, to) => handlersRef.current.onCommentClick(from, to),
      onAcceptSuggestion: (from, to) => handlersRef.current.onAcceptSuggestion(from, to),
      onRejectSuggestion: (from, to) => handlersRef.current.onRejectSuggestion(from, to),
    }),
    [],
  );

  const onUpdate = useCallback((u: ViewUpdate) => {
    // Re-anchor the sidebar only on geometry changes that are NOT from a doc edit
    // (resize/reflow/font). geometryChanged fires on nearly every keystroke (content
    // height changes), but doc edits are already covered by the sidebar's `threads`
    // dep — bumping here too would re-measure twice per keystroke. Scroll is handled
    // imperatively inside the sidebar, so we never bump on viewportChanged.
    if (u.geometryChanged && !u.docChanged) setRepositionKey((k) => k + 1);
    if (u.selectionSet || u.docChanged) {
      setHasSelection(!u.state.selection.main.empty);
    }
  }, []);

  const editor = useCodeMirror({
    initialDoc,
    callbacks: stableCallbacks,
    onDocChanged: (content) => {
      setDoc(content);
      save(content);
    },
    onUpdate,
    lineNumbers: settings.lineNumbers,
    page: settings.page,
    bionic: settings.bionic,
    pageBreaks: settings.pageBreaks,
  });

  // Selection state powers the "Add comment" affordance.
  const [hasSelection, setHasSelection] = useState(false);

  // The comment composer (state + post/suggest-edit actions) — see hooks/useComposer.
  const {
    composing,
    setComposing,
    draft,
    setDraft,
    composerAnchored,
    openComposer,
    postComment,
    suggestEditOnSelection,
  } = useComposer(editor.viewRef, settings.author, setSeen);

  // Surface the (once-created) view as state so the sidebar gets it. The hook's
  // view-creation effect runs before this one (registered earlier), so viewRef is
  // populated by now.
  useEffect(() => {
    setView(editor.viewRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On load, land where the conversation is (#20): scroll to the LAST open
  // (unseen) thread's anchor — or the last thread overall when everything's
  // seen — instead of the top. One-shot on mount: threads/seen are both derived
  // synchronously from the initial doc + localStorage, so the first run sees the
  // real targets; the guard trips regardless so a thread added later by an agent
  // never yanks the reader's scroll. rAF lets CM finish its first measure.
  // KNOWN trade-off: the server's seen-set hydrates async (fetchConfig) and may
  // be ahead of localStorage on a multi-device setup — we scroll against the
  // local snapshot rather than visibly delaying the landing on a fetch.
  const didInitialScroll = useRef(false);
  useEffect(() => {
    if (didInitialScroll.current) return;
    didInitialScroll.current = true;
    const v = editor.viewRef.current;
    if (!v || threads.length === 0) return;
    const ordered = [...threads].sort((a, b) => a.from - b.from);
    const unseen = ordered.filter((t) => !t.comments.every((c) => seen.has(commentKey(c))));
    const target = (unseen.length ? unseen : ordered).at(-1)!;
    requestAnimationFrame(() => {
      v.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Register the remote-update handler: rebase the editor (scroll-preserving) and
  // mirror into `doc`. applyRemote tags the transaction so it won't echo-save.
  // Clearing activeId is essential: token ids are positional, so a background
  // agent edit that adds/removes a token above the active one would otherwise
  // leave activeId pointing at a DIFFERENT token (a stray Alt+Y could then accept
  // the wrong suggestion). Also drains any update buffered before this ran.
  useEffect(() => {
    const handler = (content: string) => {
      editor.applyRemote(content);
      setDoc(content);
      setActiveId(null);
    };
    remoteRef.current = handler;
    if (pendingRemote.current) {
      const buffered = pendingRemote.current;
      pendingRemote.current = null;
      handler(buffered.content);
    }
    return () => {
      remoteRef.current = null;
    };
  }, [editor, remoteRef, pendingRemote]);

  // ── Buffer mutations (the shared grammar over the source-of-truth buffer) ─────
  const gotoToken = useCallback(
    (token: CritToken) => {
      setActiveId(token.id);
      const v = editor.viewRef.current;
      if (!v) return;
      v.dispatch({ effects: EditorView.scrollIntoView(token.from, { y: "center" }) });
    },
    [editor.viewRef],
  );

  const applyMutation = useCallback(
    (from: number, to: number, mode: "accept" | "reject") => {
      const v = editor.viewRef.current;
      if (!v) return;
      const raw = v.state.doc.sliceString(from, to);
      const insert = applySuggestion(raw, mode);
      v.dispatch({ changes: { from, to, insert } });
      setActiveId(null);
    },
    [editor.viewRef],
  );

  const resolveComment = useCallback(
    (token: CommentToken) => {
      const v = editor.viewRef.current;
      if (!v) return;
      // Strip the whole anchor (highlight + comment), not just the comment, so no
      // orphaned `{==…==}` is left behind.
      const edit = resolveAnchorEdit(v.state.doc.toString(), token.from, token.to);
      v.dispatch({ changes: edit });
      // Clear selection: this edit shifts every later token's positional id.
      setActiveId(null);
    },
    [editor.viewRef],
  );

  const acceptToken = useCallback(
    (t: SuggestionToken) => applyMutation(t.from, t.to, "accept"),
    [applyMutation],
  );
  const rejectToken = useCallback(
    (t: SuggestionToken) => applyMutation(t.from, t.to, "reject"),
    [applyMutation],
  );

  // Accept / reject a structured `SUGGEST:` comment. Accept keeps the proposed
  // wording, reject keeps the original span; both keep any surrounding discussion
  // (suggestionThreadEdit). No-op if it isn't an anchored suggestion.
  const runSuggestionEdit = useCallback(
    (comment: CommentToken, mode: "accept" | "reject") => {
      const v = editor.viewRef.current;
      if (!v) return;
      const edit = suggestionThreadEdit(v.state.doc.toString(), comment, mode);
      if (edit) {
        v.dispatch({ changes: edit });
        setActiveId(null);
      }
    },
    [editor.viewRef],
  );

  // Accept / reject EVERY member of a suggestion group (#21) as ONE transaction
  // (array of changes in original coordinates → atomic apply + a single undo).
  const runGroupEdit = useCallback(
    (groupId: string, mode: "accept" | "reject") => {
      const v = editor.viewRef.current;
      if (!v) return;
      const { edits } = suggestionGroupEdits(v.state.doc.toString(), groupId, mode);
      if (edits.length) {
        v.dispatch({ changes: edits });
        setActiveId(null);
      }
    },
    [editor.viewRef],
  );

  // ── Comment threads ───────────────────────────────────────────────────────────
  const focusThread = useCallback(
    (thread: CommentThread) => {
      // A suggestion card may have no comments — fall back to the card's own id so it
      // still activates (and the editor scrolls to its anchor).
      setActiveId(thread.comments[0]?.id ?? thread.id);
      // "nearest": only scroll if the anchor is OFF-screen, and then by the minimum
      // needed — so clicking a comment you can already see does NOT travel the page
      // (the jarring part). Off-screen anchors get a gentle nudge into view, not a
      // jump-to-top. The magnetic card still floats to the anchor line.
      editor.viewRef.current?.dispatch({
        effects: EditorView.scrollIntoView(thread.from, { y: "nearest", yMargin: 24 }),
      });
    },
    [editor.viewRef],
  );

  const toggleSeen = useCallback(
    (thread: CommentThread) => {
      const wasSeen = thread.comments.every((c) => seen.has(commentKey(c)));
      const next = new Set(seen);
      for (const c of thread.comments) {
        const k = commentKey(c);
        if (wasSeen) next.delete(k);
        else next.add(k);
      }
      setSeen(next);
      if (!wasSeen) {
        // Just marked seen → advance to the NEXT still-unseen thread (inbox style):
        // select it + scroll its anchor into view, so review keeps flowing. Wrap to
        // the first unseen if none follow; clear when everything's caught up.
        const ordered = [...threads].sort((a, b) => a.from - b.from);
        const idx = ordered.findIndex((t) => t.id === thread.id);
        const isUnseen = (t: CommentThread) => !t.comments.every((c) => next.has(commentKey(c)));
        const target = ordered.slice(idx + 1).find(isUnseen) ?? ordered.find(isUnseen) ?? null;
        setActiveId(target ? target.comments[0].id : null);
        if (target) {
          editor.viewRef.current?.dispatch({
            effects: EditorView.scrollIntoView(target.from, { y: "nearest" }),
          });
        }
      }
    },
    [seen, threads, editor.viewRef],
  );

  // Clicking comment-anchored highlighted text focuses its comment (same as the
  // dot) — the whole span is a target, not just the tiny glyph. A no-op for plain
  // highlights or normal prose, so it never interferes with cursor placement.
  const focusCommentAtPoint = useCallback(
    (clientX: number, clientY: number) => {
      const v = editor.viewRef.current;
      if (!v) return;
      const pos = v.posAtCoords({ x: clientX, y: clientY });
      if (pos == null) return;
      const hl = tokens.find((t) => t.type === "highlight" && pos >= t.from && pos <= t.to);
      if (!hl) return;
      const comment = tokens.find((t) => isComment(t) && t.from === hl.to);
      if (!comment) return;
      const thread = threads.find((th) => th.comments.some((c) => c.id === comment.id));
      if (thread) focusThread(thread);
    },
    [editor.viewRef, tokens, threads, focusThread],
  );

  // Jump to the first markup defect (leaking highlight, stray close, malformed
  // comment — anything the validator flags). Reuses the diagnostics memo — same
  // source as the pill count, so jump target and count can't disagree.
  const goToFirstIssue = useCallback(() => {
    const v = editor.viewRef.current;
    const first = diagnostics[0];
    if (v && first) v.dispatch({ effects: EditorView.scrollIntoView(first.from, { y: "center" }) });
  }, [editor.viewRef, diagnostics]);

  // Hard-wrap the prose to 88 columns (#10) — markup-safe (constructs are atomic,
  // so token ids and seen-state survive). A normal editor edit: saves + undoable.
  const wrapDoc = useCallback(() => {
    const v = editor.viewRef.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    const wrapped = hardWrap(cur, 88);
    if (wrapped !== cur) v.dispatch({ changes: dispatchableDiff(cur, wrapped) });
  }, [editor.viewRef]);

  // ── Command palette (⌘K) ──────────────────────────────────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-heal EVERYTHING mechanical: nested comments flattened, comments trapped
  // in tracked changes moved out, multi-block anchors re-anchored on their final
  // block. A normal editor edit, so it saves cleanly and is undoable (Cmd+Z).
  const healAll = useCallback(() => {
    const v = editor.viewRef.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    const healed = healDocument(cur);
    if (healed !== cur) v.dispatch({ changes: dispatchableDiff(cur, healed) });
  }, [editor.viewRef]);

  // Heal ONE issue (from the per-issue review). Dispatches the MINIMAL ranged change
  // (not a whole-doc replace), so each heal is its own granular, undoable edit and
  // the page doesn't jump.
  const healOne = useCallback((from: number) => {
    const v = editor.viewRef.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    const healed = healOneNestedComment(cur, from);
    if (healed && healed !== cur) v.dispatch({ changes: dispatchableDiff(cur, healed) });
  }, [editor.viewRef]);

  const jumpTo = useCallback((from: number) => {
    editor.viewRef.current?.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
  }, [editor.viewRef]);

  // Jump to a heading (TOC) — anchor it near the top, like Google Docs' outline.
  const jumpToHeading = useCallback((from: number) => {
    editor.viewRef.current?.dispatch({ effects: EditorView.scrollIntoView(from, { y: "start", yMargin: 8 }) });
  }, [editor.viewRef]);

  // Highlight the heading the reader is currently under: the last one at/above the
  // top of the viewport. Cheap — reads view.viewport.from on scroll (only while open).
  useEffect(() => {
    if (!view || !tocOpen || headings.length === 0) return;
    const update = () => {
      const top = view.viewport.from;
      let active: number | null = null;
      for (const h of headings) {
        if (h.from <= top) active = h.from;
        else break;
      }
      setTocActiveFrom(active);
    };
    update();
    const el = view.scrollDOM;
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, [view, tocOpen, headings]);

  const [reviewOpen, setReviewOpen] = useState(false);

  const resolveThread = useCallback(
    (thread: CommentThread) => {
      const v = editor.viewRef.current;
      if (!v) return;
      // Strip the whole anchor structure — outer `{==` opens, the highlight, and all
      // comment markers — leaving just the span prose (no orphaned highlight/mess).
      const edit = resolveAnchorEdit(v.state.doc.toString(), thread.from, thread.to);
      v.dispatch({ changes: edit });
      setActiveId(null);
    },
    [editor.viewRef],
  );

  // Delete a SINGLE comment (distinct from Resolve, which clears the whole anchor).
  // For a wrongly-inserted comment / one reply in a thread. If it's the only comment
  // on its anchor, also strip the highlight so no orphan is left.
  const deleteComment = useCallback(
    (comment: CommentToken) => {
      const v = editor.viewRef.current;
      if (!v) return;
      const thread = threads.find((th) => th.comments.some((c) => c.id === comment.id));
      if (thread && thread.comments.length === 1) {
        const edit = resolveAnchorEdit(v.state.doc.toString(), thread.from, thread.to);
        v.dispatch({ changes: edit });
      } else {
        v.dispatch({ changes: { from: comment.from, to: comment.to, insert: "" } });
      }
      setActiveId(null);
    },
    [editor.viewRef, threads],
  );

  const replyToThread = useCallback(
    (thread: CommentThread, text: string) => {
      const v = editor.viewRef.current;
      if (!v) return;
      // Insert the reply directly at the run's end so it stays adjacent (= same
      // thread). No leading space — adjacency is what groups it.
      const marker = formatComment(settings.author, text);
      v.dispatch({ changes: { from: thread.to, insert: marker } });
    },
    [editor.viewRef, settings.author],
  );

  // ⌘⇧↵ in the reply box: post the reply AND dismiss the thread (mark the whole
  // thread — including the just-added reply — seen), then advance to the next open
  // thread, like toggleSeen. Re-scanning the freshly-edited buffer means the seen
  // KEYS come from the real tokens, matching exactly what the sidebar derives (no
  // brittle reconstruction of the reply's parsed author/body).
  const replyAndSeen = useCallback(
    (thread: CommentThread, text: string) => {
      const v = editor.viewRef.current;
      if (!v) return;
      v.dispatch({ changes: { from: thread.to, insert: formatComment(settings.author, text) } });
      const content = v.state.doc.toString();
      const after = groupThreads(scanTokens(content).filter(isComment), content);
      const grown = after.find((t) => t.from <= thread.from && thread.from <= t.to) ?? thread;
      const next = new Set(seen);
      for (const c of grown.comments) next.add(commentKey(c));
      setSeen(next);
      // Advance to the next still-unseen thread (inbox flow). Use the re-scanned
      // threads — ids/offsets shift after the insert.
      const ordered = [...after].sort((a, b) => a.from - b.from);
      const idx = ordered.findIndex((t) => t.from <= thread.from && thread.from <= t.to);
      const isUnseen = (t: CommentThread) => !t.comments.every((c) => next.has(commentKey(c)));
      const target = ordered.slice(idx + 1).find(isUnseen) ?? ordered.find(isUnseen) ?? null;
      setActiveId(target ? target.comments[0].id : null);
      if (target) {
        v.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "nearest" }) });
      }
    },
    [editor.viewRef, settings.author, seen],
  );

  // Keep widget handlers fresh (they capture tokens for comment-click lookup).
  useEffect(() => {
    handlersRef.current = {
      onAccept: (from, to) => applyMutation(from, to, "accept"),
      onReject: (from, to) => applyMutation(from, to, "reject"),
      onCommentClick: (from) => {
        const hit = tokens.find((t) => isComment(t) && t.from === from);
        if (hit) setActiveId(hit.id);
      },
      onAcceptSuggestion: (from) => {
        const hit = tokens.find((t): t is CommentToken => isComment(t) && t.from === from);
        if (hit) runSuggestionEdit(hit, "accept");
      },
      onRejectSuggestion: (from) => {
        const hit = tokens.find((t): t is CommentToken => isComment(t) && t.from === from);
        if (hit) runSuggestionEdit(hit, "reject");
      },
    };
  }, [applyMutation, tokens, runSuggestionEdit]);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const goToLastThread = () => {
      const v = editor.viewRef.current;
      const last = [...threads].sort((a, b) => a.from - b.from).at(-1);
      if (v && last) v.dispatch({ effects: EditorView.scrollIntoView(last.from, { y: "center" }) });
    };
    return [
      { id: "wrap", label: "Hard-wrap prose to 88 columns", hint: "acm wrap", run: wrapDoc },
      { id: "comment", label: "Comment on selection", hint: `${MOD}↵ to post`, disabled: !hasSelection, run: openComposer },
      { id: "last-thread", label: "Go to the last comment", disabled: threads.length === 0, run: goToLastThread },
      { id: "first-issue", label: "Jump to first markup issue", hint: diagnostics.length ? String(diagnostics.length) : undefined, disabled: diagnostics.length === 0, run: goToFirstIssue },
      { id: "theme", label: settings.theme === "dark" ? "Switch to light theme" : "Switch to dark theme", run: () => onChangeSettings({ theme: settings.theme === "dark" ? "light" : "dark" }) },
      { id: "page", label: settings.page ? "Disable page view" : "Enable page view", run: () => onChangeSettings({ page: !settings.page }) },
      { id: "lines", label: settings.lineNumbers ? "Hide line numbers" : "Show line numbers", run: () => onChangeSettings({ lineNumbers: !settings.lineNumbers }) },
      { id: "bionic", label: settings.bionic ? "Disable bionic reading" : "Enable bionic reading", run: () => onChangeSettings({ bionic: !settings.bionic }) },
      { id: "pagebreaks", label: settings.pageBreaks ? "Hide A4 page breaks" : "Show A4 page breaks", run: () => onChangeSettings({ pageBreaks: !settings.pageBreaks }) },
      { id: "seen", label: settings.showSeen ? "Hide seen comments" : "Show seen comments", run: () => onChangeSettings({ showSeen: !settings.showSeen }) },
      { id: "nav", label: navOpen ? "Hide overview panel" : "Show overview panel", run: () => setNavOpen((o) => !o) },
      { id: "toc", label: tocOpen ? "Hide outline" : "Show outline", run: () => setTocOpen((o) => !o) },
    ];
  }, [editor.viewRef, threads, wrapDoc, hasSelection, openComposer, diagnostics.length, goToFirstIssue, settings, onChangeSettings, navOpen, tocOpen]);


  // ── Right-click context menu ──────────────────────────────────────────────────
  const [menu, setMenu] = useState<MenuState | null>(null);
  const replyNonce = useRef(0);
  // A nonce-tagged reply request the sidebar consumes to open a thread's reply box.
  const [replyTarget, setReplyTarget] = useState<{ id: string; n: number } | null>(null);

  const requestReply = useCallback(
    (thread: CommentThread) => {
      replyNonce.current += 1;
      setReplyTarget({ id: thread.id, n: replyNonce.current });
      focusThread(thread);
    },
    [focusThread],
  );

  const openEditorMenu = useCallback(
    (e: React.MouseEvent) => {
      const v = editor.viewRef.current;
      if (!v) return;
      const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
      const tok = pos == null ? undefined : tokens.find((t) => pos >= t.from && pos <= t.to);
      const sel = v.state.selection.main;
      const items: MenuItem[] = [];
      if (tok && isSuggestion(tok)) {
        items.push({ label: "Accept suggestion", onClick: () => acceptToken(tok) });
        items.push({ label: "Reject suggestion", danger: true, onClick: () => rejectToken(tok) });
      } else if (tok && isComment(tok)) {
        const thread = threads.find((th) => th.comments.some((c) => c.id === tok.id));
        if (thread) {
          items.push({ label: "Reply", onClick: () => requestReply(thread) });
          items.push({ label: "Resolve thread", danger: true, onClick: () => resolveThread(thread) });
        }
      } else if (!sel.empty) {
        items.push({ label: "Add comment", onClick: () => openComposer() });
      }
      if (items.length === 0) return; // nothing actionable — let the native menu show
      e.preventDefault();
      e.stopPropagation(); // don't let the open-menu's window closer eat this one
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [editor.viewRef, tokens, threads, acceptToken, rejectToken, resolveThread, requestReply, openComposer],
  );

  const openCommentMenu = useCallback(
    (thread: CommentThread, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "Reply", onClick: () => requestReply(thread) },
          { label: "Resolve thread", danger: true, onClick: () => resolveThread(thread) },
        ],
      });
    },
    [requestReply, resolveThread],
  );

  // ── Review keyboard: Alt+↓/J next, Alt+↑/K prev, Alt+Y accept, Alt+N reject ───
  // Bails when focus is in the editor (a contenteditable DIV, not INPUT/TEXTAREA)
  // or any text field, so it can't hijack CodeMirror's own Alt-navigation or turn
  // a macOS Option-key keystroke into an accept/reject while the user is typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (editor.viewRef.current?.hasFocus || el?.isContentEditable || el?.closest(".cm-content")) {
        return;
      }

      const ordered = [...tokens].sort((a, b) => a.from - b.from);
      if (ordered.length === 0) return;
      const idx = ordered.findIndex((t) => t.id === activeId);

      switch (e.code) {
        case "ArrowDown":
        case "KeyJ": {
          e.preventDefault();
          gotoToken(ordered[(idx + 1) % ordered.length] ?? ordered[0]);
          break;
        }
        case "ArrowUp":
        case "KeyK": {
          e.preventDefault();
          gotoToken(idx <= 0 ? ordered[ordered.length - 1] : ordered[idx - 1]);
          break;
        }
        case "KeyY": {
          const t = ordered[idx];
          if (t && isSuggestion(t)) {
            e.preventDefault();
            acceptToken(t);
          }
          break;
        }
        case "KeyN": {
          const t = ordered[idx];
          if (t && isSuggestion(t)) {
            e.preventDefault();
            rejectToken(t);
          }
          break;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tokens, activeId, gotoToken, acceptToken, rejectToken]);

  // Cmd/Ctrl+S saves the DOCUMENT (flush the pending write) — not the browser's
  // "save page as HTML". The file is the source of truth; this is the manual save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        flushNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flushNow]);

  // ── Tell the editor which anchor highlights are active / seen ─────────────────
  // A highlight anchors a thread when its close abuts the thread's first comment.
  // We pass the highlight `from`s so the editor can style them (colourblind-safe).
  const anchorFromForThread = useCallback(
    (thread: CommentThread) =>
      tokens.find((t) => t.type === "highlight" && t.to === thread.from)?.from ?? null,
    [tokens],
  );
  const activeAnchorFrom = useMemo(() => {
    if (!activeId) return null;
    const t = threads.find((th) => th.comments.some((c) => c.id === activeId));
    return t ? anchorFromForThread(t) : null;
  }, [activeId, threads, anchorFromForThread]);
  // Anchor `from`s of every thread matching a predicate (skipping point comments
  // with no highlight) — shared by the seen and density passes below.
  const anchorFromsWhere = useCallback(
    (pred: (th: CommentThread) => boolean): number[] => {
      const out: number[] = [];
      for (const th of threads) {
        if (!pred(th)) continue;
        const f = anchorFromForThread(th);
        if (f != null) out.push(f);
      }
      return out;
    },
    [threads, anchorFromForThread],
  );
  const seenAnchorFroms = useMemo(
    () => anchorFromsWhere((th) => th.comments.every((c) => seen.has(commentKey(c)))),
    [anchorFromsWhere, seen],
  );
  // Density: anchors whose thread carries ≥2 comments read a shade heavier (the
  // GDocs "busier region = darker" cue; true overlapping ranges can't exist in
  // CriticMarkup, so thread depth is where annotation density actually shows).
  const busyAnchorFroms = useMemo(
    () => anchorFromsWhere((th) => th.comments.length >= 2),
    [anchorFromsWhere],
  );
  useEffect(() => {
    editor.setHighlightState({ active: activeAnchorFrom, seen: seenAnchorFroms, busy: busyAnchorFroms });
  }, [editor, activeAnchorFrom, seenAnchorFroms, busyAnchorFroms]);

  // (Inline SUGGEST rendering needs no push: the editor derives the anchored
  // pairs from the document itself — see inlineSuggestionsField.)

  return (
    <div className="flex h-full flex-col bg-[var(--bg)]">
      <Header
        connected={connected}
        saveState={saveState}
        lastSavedAt={lastSavedAt}
        wordCount={wordCount}
        canComment={hasSelection}
        composing={composing}
        composerAnchored={composerAnchored}
        onWrap={wrapDoc}
        draft={draft}
        onDraftChange={setDraft}
        onOpenComposer={openComposer}
        onPostComment={() => postComment(false)}
        onPostCommentSeen={() => postComment(true)}
        onSuggestEdit={suggestEditOnSelection}
        onCancelComposer={() => setComposing(false)}
        navOpen={navOpen}
        onToggleNav={() => setNavOpen((v) => !v)}
        tocOpen={tocOpen}
        onToggleToc={() => setTocOpen((v) => !v)}
        settings={settings}
        onChangeSettings={onChangeSettings}
      />

      <div className="flex min-h-0 flex-1">
        {/* Overview panel — hidden by default; toggled from the header / settings. */}
        {navOpen ? (
          <aside className="w-72 shrink-0 overflow-hidden border-r border-[var(--line)]">
            <NavPanel
              tokens={tokens}
              filter={filter}
              onFilterChange={setFilter}
              activeId={activeId}
              onSelect={gotoToken}
              onAccept={acceptToken}
              onReject={rejectToken}
              onResolve={resolveComment}
            />
          </aside>
        ) : null}

        {/* Reading area: the editor (page) and the comment column are ONE centred
            group so comments sit just right of the page (short connectors), with the
            desk filling the outer margins in page view. */}
        <div
          ref={readingRef}
          className={`flex min-w-0 flex-1 justify-center ${settings.page ? "bg-[var(--desk)]" : "bg-[var(--bg)]"}`}
        >
          <div className="flex min-w-0" style={{ width: "100%", maxWidth: 1100 }}>
            <main className="relative min-w-0 flex-1 overflow-hidden">
              <div
                ref={editor.containerRef}
                className="h-full w-full"
                onContextMenu={openEditorMenu}
                onClick={(e) => focusCommentAtPoint(e.clientX, e.clientY)}
                style={
                  commentsVisible && scrollReach
                    ? ({ ["--acm-scroll-reach" as string]: `${scrollReach}px` })
                    : undefined
                }
              />
            </main>
            {commentsVisible ? (
              <aside className="w-80 shrink-0">
                <CommentSidebar
                  view={view}
                  cards={cards}
                  activeId={activeId}
                  seenIds={seenThreadIds}
                  showSeen={settings.showSeen}
                  unseenCount={unseenCount}
                  onToggleSeen={toggleSeen}
                  repositionKey={repositionKey}
                  replyTarget={replyTarget}
                  onResolveThread={resolveThread}
                  onDeleteComment={deleteComment}
                  onReply={replyToThread}
                  onReplyAndSeen={replyAndSeen}
                  onSuggestEdit={(t) => replyAndSeen(t, SUGGEST_EDIT_TEXT)}
                  onApplySuggestion={(c) => runSuggestionEdit(c, "accept")}
                  onRejectSuggestionEdit={(c) => runSuggestionEdit(c, "reject")}
                  applicableSuggestionIds={applicableSuggestionIds}
                  suggestionGroupOf={suggestionGroupOf}
                  onGroupEdit={runGroupEdit}
                  onAcceptSuggestion={(c) => c.kind === "suggestion" && acceptToken(c.suggestion)}
                  onRejectSuggestion={(c) => c.kind === "suggestion" && rejectToken(c.suggestion)}
                  onFocusThread={focusThread}
                  onCardContextMenu={openCommentMenu}
                  onContentExtent={(px) => setScrollReach((p) => (Math.abs(p - px) > 2 ? px : p))}
                />
              </aside>
            ) : null}
          </div>
        </div>
      </div>

      {tocOpen ? (
        <Toc
          headings={headings}
          activeFrom={tocActiveFrom}
          onJump={jumpToHeading}
          onClose={() => setTocOpen(false)}
        />
      ) : null}

      {reviewOpen ? (
        <HealReview
          content={doc}
          issues={healIssues}
          brokenTotal={diagnostics.length}
          fixableTotal={fixableCount}
          onHealOne={healOne}
          onHealAll={healAll}
          onJump={jumpTo}
          onJumpManual={goToFirstIssue}
          onClose={() => setReviewOpen(false)}
        />
      ) : diagnostics.length > 0 ? (
        // Calm, honest status pill (amber = recoverable, NOT the destructive red).
        // Splits the count: auto-fixable vs needs-you. "Review" opens the per-issue
        // walkthrough rather than blindly healing.
        <button
          type="button"
          onClick={() => setReviewOpen(true)}
          className="fixed bottom-3 right-3 z-40 flex items-center gap-2 rounded-full border border-[var(--warn)] bg-[var(--warn-bg)] py-1.5 pl-3 pr-3.5 text-[12px] shadow-lg transition-transform hover:scale-[1.03]"
          title="Some markup can't display (a leaking highlight, a stray close, or a comment inside another). Click to review and fix."
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="font-medium text-[var(--ink)]">
            {diagnostics.length} markup issue{diagnostics.length === 1 ? "" : "s"} render raw
            <span className="font-normal text-[var(--muted)]">
              {" — "}
              {fixableCount} auto-fixable
              {diagnostics.length - fixableCount > 0 ? `, ${diagnostics.length - fixableCount} need you` : ""}
            </span>
          </span>
          <span className="rounded-full bg-[var(--warn)] px-2 py-0.5 text-[11px] font-semibold text-[var(--panel)]">Review</span>
        </button>
      ) : null}

      {paletteOpen ? <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} /> : null}

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
