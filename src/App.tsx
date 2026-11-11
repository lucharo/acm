// ── ACM workspace ─────────────────────────────────────────────────────────────
// Wires the four modules into one window:
//   • useDocSync  — initial snapshot + WebSocket pushes + debounced version-checked save
//   • useCodeMirror — the editor (buffer = source of truth); local edits flow OUT
//     via onDocChanged → save; remote/agent edits flow IN via applyRemote
//   • CommentSidebar / Toc — presentational, driven by tokens scanned from the doc
//
// The editor BUFFER is ground truth; `doc` state here mirrors it so review surfaces
// can scan tokens. Accept/reject/resolve are plain ranged edits over the buffer
// (using the shared lib grammar), which then debounce-save to the file.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";

import { canQuerySelectionProvenance, useDocSync } from "./client/useDocSync";
import type { SaveState } from "./client/useDocSync";
import { fetchAcmSession } from "./client/session";
import type { AcmSession } from "./client/session";
import { runSuggestionDecision } from "./editor/suggestionApply";
import { decisionAnnotations, useCodeMirror } from "./editor/useCodeMirror";
import type { CritCallbacks } from "./editor/criticMarkupView";
import CommentSidebar, { MOD } from "./components/CommentSidebar";
import MobileCommentSheet, { mobileReviewEntryLabel } from "./components/MobileCommentSheet";
import MobileCommentComposer from "./components/MobileCommentComposer";
import SelectionActions from "./components/SelectionActions";
import HealReview from "./components/HealReview";
import Toc from "./components/Toc";
import FormatToolbar from "./components/FormatToolbar";
import Header from "./components/Header";
import { documentTabTitle } from "./lib/documentTitle";
import ContextMenu from "./components/ContextMenu";
import type { MenuItem, MenuState } from "./components/ContextMenu";
import type { ViewSettings } from "./lib/viewSettings";
import { anchorNeedsCentring, commentEdgeVisible, commentRailExpanded, stepReviewCard } from "./lib/commentRail";
import { isPrintShortcut } from "./lib/printShortcut";
import { useViewSettings, useSeenState, useDictionary, fetchConfig } from "./hooks/useConfigState";
import {
  setCustomWords,
  setSpellVariant,
  ignoreWord,
  misspelledWordAt,
  ensureSpeller,
  collectFlagged,
  fixAllEdits,
  suggestFor,
  subscribeSpell,
} from "./editor/spellcheck";
import type { FlaggedWord } from "./editor/spellcheck";
import { useDocDerived, useSeenDerived } from "./hooks/useDocDerived";
import { useComposer } from "./hooks/useComposer";
import CommandPalette from "./components/CommandPalette";
import type { PaletteAction } from "./components/CommandPalette";
import ShortcutsOverlay from "./components/ShortcutsOverlay";
import SpellingReview from "./components/SpellingReview";
import ToastStack from "./components/Toast";
import type { ToastItem } from "./components/Toast";
import PrintDocument, { waitForPrintImages } from "./components/PrintDocument";
import Launcher from "./components/Launcher";
import { toggleStrong, toggleEmphasis } from "./editor/formatting";
import { ALT } from "./lib/platform";
import { selectionAuthoringShortcut } from "./lib/shortcuts";
import type { ProvenanceSegment } from "./lib/provenance";
import { formatMarkdownTableAt } from "./editor/markdownTable";
import { TABLE_CELL_COMMENT_EVENT } from "./editor/markdownPreview";
import { flashRange } from "./editor/footnotes";
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
  hardWrap,
  acceptedMarkdown,
  suggestionGroupEdits,
  commentKey,
  commentBodyEdit,
  suggestionProposalEdit,
  type SuggestionDiscussion,
} from "./lib/criticmarkup";
import { isComment, isSuggestion } from "./lib/types";
import { EDIT_REQUEST_TEXT, noteGroupResolveEdits } from "./lib/commentGroups";
import {
  activeVisibleReviewCard,
  mobileReviewScrollOptions,
  nextVisibleReviewCard,
  visibleReviewCards,
} from "./lib/visibleReviewCards";
import {
  commentResolveDecision,
  inlineSuggestionDecision,
  structuredSuggestionGroupDecisions,
  threadResolveDecision,
  type DecisionEvent,
  type DecisionQueueUpdate,
} from "./lib/decision";
import type {
  AgentStatus,
  CritToken,
  SuggestionToken,
  CommentToken,
  CommentThread,
  SidebarCard,
} from "./lib/types";
import AgentPill, { askFeedback } from "./components/AgentPill";



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
  const [session, setSession] = useState<AcmSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const viewSettings = useViewSettings();

  useEffect(() => {
    let active = true;
    void fetchAcmSession().then(
      (next) => {
        if (active) setSession(next);
      },
      (cause) => {
        if (active) setSessionError((cause as Error).message);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (sessionError) return <SessionError message={sessionError} />;
  if (!session) return <LoadingSession />;
  if (session.mode === "launcher") return <Launcher session={session} />;
  return <DocumentApp {...viewSettings} />;
}

function DocumentApp({
  settings,
  onChangeSettings,
  settingsSaveError,
  retrySettings,
}: ReturnType<typeof useViewSettings>) {
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
    author: settings.author,
    onRemoteUpdate: (content, version) => {
      if (remoteRef.current) remoteRef.current(content, version);
      else pendingRemote.current = { content, version };
    },
  });

  if (sync.initialDoc === null || sync.documentPath === null) {
    return <Loading connected={sync.connected} />;
  }
  return (
    <Workspace
      initialDoc={sync.initialDoc}
      documentPath={sync.documentPath}
      save={sync.save}
      flushNow={sync.flushNow}
      reportSelection={sync.reportSelection}
      connected={sync.connected}
      saveState={sync.saveState}
      lastSavedAt={sync.lastSavedAt}
      agentStatus={sync.agentStatus}
      remoteRef={remoteRef}
      pendingRemote={pendingRemote}
      settings={settings}
      onChangeSettings={onChangeSettings}
      settingsSaveError={settingsSaveError}
      onRetrySettings={retrySettings}
    />
  );
}

function LoadingSession() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
      Opening ACM…
    </div>
  );
}

function SessionError({ message }: { message: string }) {
  return (
    <main className="flex h-full items-center justify-center bg-[var(--desk)] p-6 text-[var(--ink)]">
      <div className="max-w-md rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5 shadow-sm">
        <h1 className="text-base font-semibold">ACM could not start</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{message}</p>
      </div>
    </main>
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
  documentPath: string;
  save: (content: string, decisionUpdate?: DecisionQueueUpdate) => void;
  flushNow: () => void;
  reportSelection: (from: number, to: number) => void;
  connected: boolean;
  saveState: SaveState;
  lastSavedAt: number | null;
  agentStatus: AgentStatus | null;
  remoteRef: React.MutableRefObject<
    ((content: string, version: number) => void) | null
  >;
  pendingRemote: React.MutableRefObject<{ content: string; version: number } | null>;
  settings: ViewSettings;
  onChangeSettings: (patch: Partial<ViewSettings>) => void;
  settingsSaveError: boolean;
  onRetrySettings: () => void;
}

function Workspace({
  initialDoc,
  documentPath,
  save,
  flushNow,
  reportSelection,
  connected,
  saveState,
  lastSavedAt,
  agentStatus,
  remoteRef,
  pendingRemote,
  settings,
  onChangeSettings,
  settingsSaveError,
  onRetrySettings,
}: WorkspaceProps) {
  // `doc` mirrors the editor buffer so review surfaces can scan tokens.
  const [doc, setDoc] = useState(initialDoc);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [repositionKey, setRepositionKey] = useState(0);
  const [view, setView] = useState<EditorView | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [tocActiveFrom, setTocActiveFrom] = useState<number | null>(null);
  // Extra scroll reach (px of scroller bottom padding) so cards stacked below the
  // last line stay reachable — reported by the sidebar as overflow past the last
  // text line. 0 = no overflow. Padding, not content min-height: the page sheet
  // must never stretch past the prose (the old approach left a huge white gap).
  const [scrollReach, setScrollReach] = useState(0);

  // Hide the right-margin comment column when the reading area is too narrow to
  // fit both the prose and the ~320px comments — below this the editor is
  // unreadably cramped. The inline comment dots and mobile comments sheet keep
  // comments reachable. Driven by the reading area's actual width.
  const readingRef = useRef<HTMLDivElement | null>(null);
  const [commentRailWideEnough, setCommentRailWideEnough] = useState(true);
  useEffect(() => {
    const el = readingRef.current;
    if (!el) return;
    const COMMENTS_MIN_WIDTH = 800;
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1].contentRect.width;
      setCommentRailWideEnough(w >= COMMENTS_MIN_WIDTH);
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
    applicableSuggestionIds,
    suggestionAnchorTextById,
    healIssues,
    diagnostics,
    fixableCount,
    groupOf,
    groupMembersOf,
    groupNotesOf,
    anchoredCardIds,
  } = useDocDerived(doc);

  // "Seen" tracking — content-keyed, non-destructive (state + persistence in
  // useConfigState).
  const documentCommentKeys = useMemo(
    () => new Set(threads.flatMap((thread) => thread.comments.map(commentKey))),
    [threads],
  );
  const { seen, setSeen } = useSeenState(documentPath, documentCommentKeys);

  useEffect(() => {
    document.title = documentTabTitle(documentPath);
  }, [documentPath]);

  // Personal spelling dictionary (persisted). Mirror it into the spellcheck engine
  // whenever it changes so the underline + suggestions honour the user's words.
  const { dictionary, addWord, removeWord } = useDictionary();
  useEffect(() => {
    setCustomWords(dictionary);
  }, [dictionary]);
  // Keep the spellchecker on the selected dictionary (UK/US). Switching rebuilds the
  // engine; the underline repaints once the new variant is ready.
  useEffect(() => {
    setSpellVariant(settings.spellVariant);
  }, [settings.spellVariant]);
  // Per-document ignore list (`acm spell ignore`): seed the session ignore set from
  // settings.json's spellIgnore[<this doc's path>] so CLI-ignored words don't
  // squiggle here either. One-way — the in-app Ignore action stays session-only.
  // Re-seeds on window focus so a CLI ignore lands without a reload (ignoreWord is
  // a Set-add, so re-seeding already-known words is a no-op).
  useEffect(() => {
    const seed = async () => {
      const cfg = await fetchConfig();
      const map = cfg?.spellIgnore;
      const words =
        map && typeof map === "object" && !Array.isArray(map)
          ? (map as Record<string, string[]>)[documentPath]
          : undefined;
      if (Array.isArray(words)) for (const w of words) ignoreWord(w);
    };
    void seed();
    const onFocus = () => void seed();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [documentPath]);
  const { seenThreadIds, unseenCount } = useSeenDerived(commentCards, seen);
  const visibleCards = useMemo(
    () => visibleReviewCards(cards, seenThreadIds, settings.showSeen),
    [cards, seenThreadIds, settings.showSeen],
  );
  const hasVisibleCards = visibleCards.length > 0;
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
      const sel = u.state.selection.main;
      setHasSelection(!sel.empty);
      setSelectionRange(sel.empty ? null : { from: sel.from, to: sel.to });
      setCursorLine(u.state.doc.lineAt(sel.head).number);
      // Tell the server where the caret is so agent writes avoid this span (#38).
      reportSelection(sel.from, sel.to);
    }
  }, [reportSelection]);

  // The keyboard-shortcuts cheat sheet — opened from the palette, settings, and
  // ⌘/. Declared here (ahead of useCodeMirror) so the editor's ⌘/ keybinding can
  // toggle it via onShowShortcuts.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Bottom-right toasts — feedback for actions with an off-screen side effect
  // (an image drop writes a file: "Saved assets/…"). Auto-dismiss after 4s.
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);
  const toastTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const pushToast = useCallback((message: string, kind: ToastItem["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { id, message, kind }]);
    toastTimers.current.set(
      id,
      setTimeout(() => {
        toastTimers.current.delete(id);
        setToasts((ts) => ts.filter((t) => t.id !== id));
      }, 4000),
    );
  }, []);
  // Pending dismiss timers must not fire into an unmounted Workspace.
  useEffect(() => () => toastTimers.current.forEach(clearTimeout), []);
  const toggleNotifyEach = useCallback(
    () => onChangeSettings({ notifyEachComment: !settings.notifyEachComment }),
    [onChangeSettings, settings.notifyEachComment],
  );

  const editor = useCodeMirror({
    initialDoc,
    callbacks: stableCallbacks,
    onDocChanged: (content, decisionUpdate) => {
      setDoc(content);
      save(content, decisionUpdate);
    },
    onUpdate,
    onShowShortcuts: () => setShortcutsOpen((o) => !o),
    onToast: pushToast,
    lineNumbers: settings.lineNumbers,
    page: settings.page,
    bionic: settings.bionic,
    spellcheck: settings.spellcheck,
    richPreview: settings.richPreview,
  });

  // Selection state powers the "Add comment" affordance.
  const [hasSelection, setHasSelection] = useState(false);
  // The caret's line, so the toolbar's paragraph-style menu follows the cursor.
  const [cursorLine, setCursorLine] = useState(1);
  const [selectionRange, setSelectionRange] = useState<{ from: number; to: number } | null>(null);
  const [selectionProvenance, setSelectionProvenance] = useState<ProvenanceSegment[] | null>(null);
  const [selectionProvenanceLoading, setSelectionProvenanceLoading] = useState(false);

  useEffect(() => {
    if (!selectionRange || !canQuerySelectionProvenance(saveState, connected)) {
      setSelectionProvenance(null);
      setSelectionProvenanceLoading(false);
      return;
    }
    const controller = new AbortController();
    setSelectionProvenanceLoading(true);
    const query = new URLSearchParams({
      from: String(selectionRange.from),
      to: String(selectionRange.to),
    });
    void fetch(`/api/provenance?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`provenance request failed (${response.status})`);
        return response.json() as Promise<{ segments?: ProvenanceSegment[] }>;
      })
      .then((result) => {
        if (!controller.signal.aborted) {
          setSelectionProvenance(Array.isArray(result.segments) ? result.segments : []);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setSelectionProvenance([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSelectionProvenanceLoading(false);
      });
    return () => controller.abort();
  }, [selectionRange, lastSavedAt, saveState, connected]);

  // Spelling review modal: a deduped list of every flagged word in the document.
  // `flagged` is recomputed fresh whenever the list is shown (settings popover or the
  // modal) — a whole-doc scan, cheap without suggestions; never per-keystroke.
  const [spellReviewOpen, setSpellReviewOpen] = useState(false);
  const [flagged, setFlagged] = useState<FlaggedWord[]>([]);
  const refreshFlagged = useCallback(() => {
    const v = editor.viewRef.current;
    ensureSpeller(); // idempotent — covers spell check having just been switched on
    setFlagged(v ? collectFlagged(v) : []);
  }, [editor.viewRef]);
  const openSpellReview = useCallback(() => {
    refreshFlagged();
    setSpellReviewOpen(true);
  }, [refreshFlagged]);
  // Fix every occurrence of a flagged word in one undoable, case-preserving edit.
  const fixSpelling = useCallback(
    (lower: string, replacement: string) => {
      const v = editor.viewRef.current;
      if (!v) return;
      const edits = fixAllEdits(v, lower, replacement);
      if (edits.length) v.dispatch({ changes: edits });
    },
    [editor.viewRef],
  );

  // The comment composer (state + post/suggest-edit actions) — see hooks/useComposer.
  const {
    composing,
    draft,
    setDraft,
    composerKind,
    composerAnchored,
    openComposer,
    openSuggestionComposer,
    cancelComposer,
    postComment,
  } = useComposer(
    editor.viewRef,
    settings.author,
    setSeen,
    editor.setComposerAnchor,
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = selectionAuthoringShortcut(event);
      if (!action) return;
      const current = editor.viewRef.current;
      if (!current?.hasFocus || current.state.selection.main.empty) return;
      event.preventDefault();
      if (action === "comment") openComposer();
      else openSuggestionComposer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor.viewRef, openComposer, openSuggestionComposer]);

  useEffect(() => {
    const current = view ?? editor.viewRef.current;
    if (!current) return;
    const onTableCellComment = (event: Event) => {
      const detail = (event as CustomEvent<{ from: number; to: number }>).detail;
      if (!detail || detail.to <= detail.from) return;
      current.dispatch({
        selection: { anchor: detail.from, head: detail.to },
        scrollIntoView: true,
      });
      current.focus();
      openComposer();
    };
    current.dom.addEventListener(TABLE_CELL_COMMENT_EVENT, onTableCellComment);
    return () => current.dom.removeEventListener(TABLE_CELL_COMMENT_EVENT, onTableCellComment);
  }, [view, editor.viewRef, openComposer]);

  // A new composer belongs to the comment rail just like an existing thread. Keep
  // the surface mounted for its final fade, but collapse the column immediately
  // once neither a visible card nor a composer needs it.
  const railNeeded = commentRailExpanded(settings.commentRail, hasVisibleCards, composing);
  const [railMounted, setRailMounted] = useState(railNeeded);
  useEffect(() => {
    if (railNeeded && commentRailWideEnough) {
      setRailMounted(true);
      return;
    }
    const timer = setTimeout(() => setRailMounted(false), 220);
    return () => clearTimeout(timer);
  }, [railNeeded, commentRailWideEnough]);
  const railExpanded = commentRailWideEnough && railNeeded;
  const railSurfaceMounted = commentRailWideEnough && (railMounted || railNeeded);
  const commentsEdgeVisible = commentEdgeVisible(
    settings.commentRail,
    commentRailWideEnough,
    railExpanded,
    hasVisibleCards,
  );
  useEffect(() => {
    if (!railExpanded) setScrollReach(0);
  }, [railExpanded]);
  const toggleCommentRail = useCallback(() => {
    onChangeSettings({ commentRail: commentsEdgeVisible ? "hide" : "show" });
  }, [commentsEdgeVisible, onChangeSettings]);

  // Surface the (once-created) view as state so the sidebar gets it. The hook's
  // view-creation effect runs before this one (registered earlier), so viewRef is
  // populated by now.
  useEffect(() => {
    setView(editor.viewRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reading-progress bar: how far the reader has scrolled through the document,
  // 0→1. Measured off the editor's own scroller (the buffer is the scroll
  // container). rAF-coalesced so a burst of scroll events repaints once per
  // frame, and re-measured when EITHER the content height (typing, reflow, font
  // swap, a remote edit) OR the viewport height changes (window resize while
  // scrolled — that shifts clientHeight, the denominator) so the bar stays
  // honest without a scroll event.
  const [readProgress, setReadProgress] = useState(0);
  useEffect(() => {
    if (!view || !settings.progressBar) return;
    const scroller = view.scrollDOM;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const max = scroller.scrollHeight - scroller.clientHeight;
      setReadProgress(max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 0);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(view.contentDOM); // content height (scrollHeight)
    ro.observe(scroller); // viewport height (clientHeight — the denominator)
    return () => {
      scroller.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [view, settings.progressBar]);

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

  // Locate an edit: scroll a span into view and flash it (no cursor move). Used by
  // the group views to jump from a member row to the exact span it edits.
  const locateSpan = useCallback(
    (from: number, to: number) => {
      const v = editor.viewRef.current;
      if (v) flashRange(v, from, to);
    },
    [editor.viewRef],
  );

  const applyMutation = useCallback(
    (from: number, to: number, mode: "accept" | "reject") => {
      const v = editor.viewRef.current;
      if (!v) return;
      const content = v.state.doc.toString();
      const token = scanTokens(content).find(
        (candidate): candidate is SuggestionToken =>
          isSuggestion(candidate) && candidate.from === from && candidate.to === to,
      );
      if (!token) return;
      const raw = content.slice(from, to);
      const insert = applySuggestion(raw, mode);
      const event = inlineSuggestionDecision(token, mode, settings.author, "gui");
      v.dispatch({
        changes: { from, to, insert },
        annotations: decisionAnnotations([event]),
      });
      setActiveId(null);
    },
    [editor.viewRef, settings.author],
  );

  const resolveComment = useCallback(
    (token: CommentToken) => {
      const v = editor.viewRef.current;
      if (!v) return;
      // Strip the whole anchor (highlight + comment), not just the comment, so no
      // orphaned `{==…==}` is left behind.
      const content = v.state.doc.toString();
      const edit = resolveAnchorEdit(content, token.from, token.to);
      const event = commentResolveDecision(content, token, settings.author, "gui");
      v.dispatch({ changes: edit, annotations: decisionAnnotations([event]) });
      // Clear selection: this edit shifts every later token's positional id.
      setActiveId(null);
    },
    [editor.viewRef, settings.author],
  );

  const acceptToken = useCallback(
    (t: SuggestionToken) => applyMutation(t.from, t.to, "accept"),
    [applyMutation],
  );
  const rejectToken = useCallback(
    (t: SuggestionToken) => applyMutation(t.from, t.to, "reject"),
    [applyMutation],
  );
  const defaultApplyDiscussion: SuggestionDiscussion = settings.applyAndResolve
    ? "resolve-thread"
    : "keep-discussion";

  // Accept / reject a structured `SUGGEST:` comment. Ordinary Apply keeps the
  // surrounding discussion; Apply & resolve consumes the complete thread in the
  // same CodeMirror transaction as the wording change.
  const runSuggestionEdit = useCallback(
    (
      comment: CommentToken,
      mode: "accept" | "reject",
      discussion: SuggestionDiscussion = "keep-discussion",
    ) => {
      const v = editor.viewRef.current;
      if (!v) return;
      const changed = runSuggestionDecision(v, comment, mode, discussion, settings.author, (message) =>
        pushToast(message, "error"),
      );
      if (changed) setActiveId(null);
    },
    [editor.viewRef, pushToast, settings.author],
  );

  // Accept / reject EVERY member of a suggestion group (#21), or all but the
  // `unticked` ones (#25), as ONE transaction (array of changes in original
  // coordinates → atomic apply + a single undo). Edits and decision events use the
  // same `unticked`, so the history matches what changed.
  const runGroupEdit = useCallback(
    (
      groupId: string,
      mode: "accept" | "reject",
      discussion: SuggestionDiscussion = "keep-discussion",
      unticked?: ReadonlySet<string>,
    ) => {
      const v = editor.viewRef.current;
      if (!v) return;
      const content = v.state.doc.toString();
      const effectiveDiscussion = mode === "accept" ? discussion : "keep-discussion";
      const { edits, skipped } = suggestionGroupEdits(
        content,
        groupId,
        mode,
        effectiveDiscussion,
        unticked,
      );
      if (edits.length) {
        const events = structuredSuggestionGroupDecisions(
          content,
          groupId,
          mode,
          mode === "accept"
            ? effectiveDiscussion === "resolve-thread"
              ? "apply-resolve"
              : "apply"
            : "reject",
          settings.author,
          "gui",
          unticked,
        );
        if (events.length !== edits.length) {
          pushToast("Could not record every group decision. No changes were made.", "error");
          return;
        }
        v.dispatch({ changes: edits, annotations: decisionAnnotations(events) });
        setActiveId(null);
        if (skipped > 0) {
          pushToast(
            `${skipped} conflicting group edit${skipped === 1 ? " was" : "s were"} left open.`,
          );
        }
      } else if (skipped > 0) {
        pushToast(
          `No changes made: ${skipped} conflicting group edit${skipped === 1 ? " remains" : "s remain"} open.`,
          "error",
        );
      }
    },
    [editor.viewRef, pushToast, settings.author],
  );

  // ── Comment threads ───────────────────────────────────────────────────────────
  // Travel to a card's anchor (#43): an anchor already comfortably in view stays
  // put, so clicking a visible card does not move the page; otherwise it lands in
  // the MIDDLE of the view, not at the bottom edge where "nearest" left it with its
  // card cut off. The magnetic card then floats to the anchor line.
  const revealReviewAnchor = useCallback((v: EditorView, from: number) => {
    const coords = v.coordsAtPos(from);
    const box = v.scrollDOM.getBoundingClientRect();
    if (!coords || anchorNeedsCentring(coords.top, coords.bottom, box.top, box.bottom)) {
      v.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
    }
  }, []);

  const focusThread = useCallback(
    (thread: CommentThread) => {
      // A suggestion card may have no comments — fall back to the card's own id so it
      // still activates (and the editor scrolls to its anchor).
      setActiveId(thread.comments[0]?.id ?? thread.id);
      const v = editor.viewRef.current;
      if (v) revealReviewAnchor(v, thread.from);
    },
    [editor.viewRef, revealReviewAnchor],
  );

  const focusMobileReviewCard = useCallback(
    (card: SidebarCard) => {
      setActiveId(card.comments[0]?.id ?? card.id);
      editor.viewRef.current?.dispatch({
        effects: EditorView.scrollIntoView(card.from, mobileReviewScrollOptions()),
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
        const v = editor.viewRef.current;
        if (target && v) {
          if (commentRailWideEnough) revealReviewAnchor(v, target.from);
          else v.dispatch({ effects: EditorView.scrollIntoView(target.from, mobileReviewScrollOptions()) });
        }
      }
    },
    [seen, threads, editor.viewRef, commentRailWideEnough, revealReviewAnchor],
  );

  // Clicking comment-anchored highlighted text focuses its comment (same as the
  // dot) — the whole span is a target, not just the tiny glyph. A no-op for plain
  // highlights or normal prose, so it never interferes with cursor placement.
  const focusCommentAtPoint = useCallback(
    (clientX: number, clientY: number, target: HTMLElement | null = null) => {
      const v = editor.viewRef.current;
      if (!v) return;
      const directFrom = Number(target?.closest<HTMLElement>("[data-comment-from]")?.dataset.commentFrom);
      if (Number.isFinite(directFrom)) {
        const direct = tokens.find((token) => isComment(token) && token.from === directFrom);
        const thread = direct
          ? threads.find((candidate) => candidate.comments.some((comment) => comment.id === direct.id))
          : null;
        if (thread) {
          focusThread(thread);
          return;
        }
      }
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

  const printResult = useMemo(() => acceptedMarkdown(doc), [doc]);
  const requestPrint = useCallback(() => {
    if (!printResult.ok) {
      pushToast(
        `Fix ${printResult.diagnostics.length} markup issue${printResult.diagnostics.length === 1 ? "" : "s"} before exporting so review delimiters cannot leak into the PDF.`,
        "error",
      );
      goToFirstIssue();
      return;
    }
    void (async () => {
      const root = document.getElementById("acm-print-document");
      const pendingImages = root ? await waitForPrintImages(root) : [];
      if (pendingImages.length > 0) {
        pushToast(
          `${pendingImages.length} image${pendingImages.length === 1 ? " is" : "s are"} still loading and may be omitted from the PDF.`,
          "error",
        );
      }
      window.print();
    })();
  }, [goToFirstIssue, printResult, pushToast]);

  // Hard-wrap the prose to 88 columns (#10) — markup-safe (constructs are atomic,
  // so token ids and seen-state survive). A normal editor edit: saves + undoable.
  const wrapDoc = useCallback(() => {
    const v = editor.viewRef.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    const wrapped = hardWrap(cur, 88);
    if (wrapped !== cur) v.dispatch({ changes: dispatchableDiff(cur, wrapped) });
  }, [editor.viewRef]);

  const formatTableSource = useCallback(() => {
    const v = editor.viewRef.current;
    if (!v) return;
    const result = formatMarkdownTableAt(v.state, v.state.selection.main.head);
    if (result.status === "not-table") {
      pushToast("Place the cursor in a valid top-level Markdown table first.", "error");
      return;
    }
    if (result.status === "unchanged") {
      pushToast("This table source is already aligned.");
      return;
    }
    v.dispatch({ changes: result.change, scrollIntoView: true });
    pushToast("Table source aligned. Undo restores the previous spacing.");
  }, [editor.viewRef, pushToast]);

  // ── Command palette (⌘K) ──────────────────────────────────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Settings menu lives in the header but its open-state is lifted here so ⌘,
  // can toggle it (a keyboard handler can't reach the header's local state).
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Refresh the flagged-word count when the settings popover opens, so the Spelling
  // tab's "Review N flagged words" button is current without scanning every keystroke.
  useEffect(() => {
    if (settingsOpen && settings.spellcheck) refreshFlagged();
  }, [settingsOpen, settings.spellcheck, refreshFlagged]);
  // While the review/settings is open, re-scan when the engine notifies (it may
  // finish loading, or the variant/dictionary may change, after we first scanned) —
  // otherwise the count/modal can sit stale on an empty "all clear".
  useEffect(() => {
    if (!spellReviewOpen && !settingsOpen) return;
    return subscribeSpell(refreshFlagged);
  }, [spellReviewOpen, settingsOpen, refreshFlagged]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (isPrintShortcut(e)) {
        e.preventDefault();
        requestPrint();
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (mod && !e.shiftKey && !e.altKey && e.key === ",") {
        // ⌘, → Settings (Google-Docs/macOS convention). Some browsers reserve
        // ⌘, for their own preferences and will swallow it before we see it —
        // the cog and the ⌘K palette remain as fallbacks.
        e.preventDefault();
        setSettingsOpen((o) => !o);
      } else if (mod && !e.shiftKey && !e.altKey && e.key === "/") {
        // ⌘/ → keyboard-shortcuts cheat sheet (Google-Docs convention). When the
        // editor is focused its own keymap owns ⌘/ (and suppresses CodeMirror's
        // toggle-comment); this window branch covers focus being elsewhere.
        if (!editor.viewRef.current?.hasFocus) {
          e.preventDefault();
          setShortcutsOpen((o) => !o);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor.viewRef, requestPrint]);

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
      const content = v.state.doc.toString();
      const edit = resolveAnchorEdit(content, thread.from, thread.to);
      const event = threadResolveDecision(content, thread, settings.author, "gui");
      v.dispatch({ changes: edit, annotations: decisionAnnotations([event]) });
      // Move on to the next card still in the rail (#43), read from the edited
      // buffer because every offset after the resolved span has shifted.
      const after = v.state.doc.toString();
      const afterCards = groupCards(scanTokens(after), after);
      const seenIds = new Set(
        afterCards
          .filter((card) => card.kind === "comment" && card.comments.every((c) => seen.has(commentKey(c))))
          .map((card) => card.id),
      );
      const remaining = visibleReviewCards(afterCards, seenIds, settings.showSeen).sort((a, b) => a.from - b.from);
      const resolvedEnd = edit.from + edit.insert.length;
      const next = remaining.find((card) => card.from >= resolvedEnd) ?? remaining[0] ?? null;
      if (!next) setActiveId(null);
      else if (commentRailWideEnough) focusThread(next);
      else focusMobileReviewCard(next);
    },
    [editor.viewRef, settings.author, settings.showSeen, seen, focusThread, focusMobileReviewCard, commentRailWideEnough],
  );

  // Resolve every note of a review group (#77) as ONE transaction (one undo), each
  // thread logged like a single Resolve.
  const resolveNoteGroup = useCallback(
    (groupId: string, unticked?: ReadonlySet<string>) => {
      const v = editor.viewRef.current;
      if (!v) return;
      const content = v.state.doc.toString();
      const { edits, threads: resolved, skipped } = noteGroupResolveEdits(content, groupId, unticked);
      if (edits.length) {
        const events = resolved.map((thread) => threadResolveDecision(content, thread, settings.author, "gui"));
        v.dispatch({ changes: edits, annotations: decisionAnnotations(events) });
        setActiveId(null);
      }
      if (skipped > 0) {
        pushToast(`${skipped} overlapping note thread${skipped === 1 ? " was" : "s were"} left open.`);
      }
    },
    [editor.viewRef, settings.author, pushToast],
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

  const editComment = useCallback(
    (comment: CommentToken, body: string) => {
      const v = editor.viewRef.current;
      if (!v) return false;
      const current = scanTokens(v.state.doc.toString()).find(
        (token): token is CommentToken => isComment(token) && token.id === comment.id,
      );
      if (!current) return false;
      const result = commentBodyEdit(current, body);
      if (!result.ok) {
        pushToast("A comment cannot be empty.", "error");
        return false;
      }
      v.dispatch({ changes: result.change });
      const fresh = scanTokens(v.state.doc.toString()).find(
        (token): token is CommentToken =>
          isComment(token) && token.from === result.change.from,
      );
      setActiveId(fresh?.id ?? null);
      return true;
    },
    [editor.viewRef, pushToast],
  );

  const editSuggestion = useCallback(
    (suggestion: CommentToken | SuggestionToken, proposal: string) => {
      const v = editor.viewRef.current;
      if (!v) return false;
      const current = scanTokens(v.state.doc.toString()).find(
        (token): token is CommentToken | SuggestionToken =>
          token.id === suggestion.id && (isComment(token) || isSuggestion(token)),
      );
      if (!current) return false;
      const result = suggestionProposalEdit(current, proposal);
      if (!result.ok) {
        const message =
          result.reason === "invalid-markup"
            ? "That wording contains CriticMarkup delimiters that cannot be embedded safely."
            : "This kind of suggestion has no editable proposed wording.";
        pushToast(message, "error");
        return false;
      }
      v.dispatch({ changes: result.change });
      const fresh = scanTokens(v.state.doc.toString()).find(
        (token) =>
          token.from === result.change.from && (isComment(token) || isSuggestion(token)),
      );
      setActiveId(fresh?.id ?? null);
      return true;
    },
    [editor.viewRef, pushToast],
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
      if (target && commentRailWideEnough) revealReviewAnchor(v, target.from);
      else if (target) v.dispatch({ effects: EditorView.scrollIntoView(target.from, mobileReviewScrollOptions()) });
    },
    [editor.viewRef, settings.author, seen, revealReviewAnchor, commentRailWideEnough],
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
        if (hit) {
          runSuggestionEdit(
            hit,
            "accept",
            defaultApplyDiscussion,
          );
        }
      },
      onRejectSuggestion: (from) => {
        const hit = tokens.find((t): t is CommentToken => isComment(t) && t.from === from);
        if (hit) runSuggestionEdit(hit, "reject");
      },
    };
  }, [applyMutation, defaultApplyDiscussion, tokens, runSuggestionEdit]);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const goToLastThread = () => {
      const v = editor.viewRef.current;
      const last = [...threads].sort((a, b) => a.from - b.from).at(-1);
      if (v && last) v.dispatch({ effects: EditorView.scrollIntoView(last.from, { y: "center" }) });
    };
    const format = (cmd: typeof toggleStrong) => () => {
      const v = editor.viewRef.current;
      if (!v) return;
      cmd(v);
      v.focus(); // the palette stole focus on open — hand it back to the editor
    };
    return [
      { id: "bold", label: "Bold selection", hint: `${MOD}B`, disabled: !hasSelection, run: format(toggleStrong) },
      { id: "italic", label: "Italic selection", hint: `${MOD}I`, disabled: !hasSelection, run: format(toggleEmphasis) },
      { id: "shortcuts", label: "Keyboard shortcuts", hint: `${MOD}/`, run: () => setShortcutsOpen(true) },
      { id: "print", label: "Print / save as PDF", hint: `${MOD}P`, run: requestPrint },
      { id: "wrap", label: "Hard-wrap prose to 88 columns", hint: "acm wrap", run: wrapDoc },
      { id: "format-table", label: "Format table source at cursor", disabled: settings.richPreview, run: formatTableSource },
      { id: "comment", label: "Comment on selection", hint: `${MOD}${ALT}M`, disabled: !hasSelection, run: openComposer },
      { id: "suggest", label: "Suggest replacement", hint: `${MOD}${ALT}S`, disabled: !hasSelection, run: openSuggestionComposer },
      { id: "last-thread", label: "Go to the last comment", disabled: threads.length === 0, run: goToLastThread },
      { id: "first-issue", label: "Jump to first markup issue", hint: diagnostics.length ? String(diagnostics.length) : undefined, disabled: diagnostics.length === 0, run: goToFirstIssue },
      { id: "theme-light", label: "Use light theme", disabled: settings.theme === "light", run: () => onChangeSettings({ theme: "light" }) },
      { id: "theme-dark", label: "Use dark theme", disabled: settings.theme === "dark", run: () => onChangeSettings({ theme: "dark" }) },
      { id: "theme-system", label: "Follow system theme", disabled: settings.theme === "system", run: () => onChangeSettings({ theme: "system" }) },
      { id: "page", label: settings.page ? "Disable page view" : "Enable page view", run: () => onChangeSettings({ page: !settings.page }) },
      { id: "lines", label: settings.lineNumbers ? "Hide line numbers" : "Show line numbers", run: () => onChangeSettings({ lineNumbers: !settings.lineNumbers }) },
      { id: "bionic", label: settings.bionic ? "Disable bionic reading" : "Enable bionic reading", run: () => onChangeSettings({ bionic: !settings.bionic }) },
      { id: "progressbar", label: settings.progressBar ? "Hide reading progress bar" : "Show reading progress bar", run: () => onChangeSettings({ progressBar: !settings.progressBar }) },
      { id: "rich-preview", label: settings.richPreview ? "Show raw Markdown source" : "Show rich preview", run: () => onChangeSettings({ richPreview: !settings.richPreview }) },
      { id: "seen", label: settings.showSeen ? "Hide seen comments" : "Show seen comments", run: () => onChangeSettings({ showSeen: !settings.showSeen }) },
      { id: "comment-edge", label: commentsEdgeVisible ? "Hide comments edge" : "Show comments edge", run: toggleCommentRail },
      { id: "comment-edge-auto", label: "Use automatic comments edge", disabled: settings.commentRail === "auto", run: () => onChangeSettings({ commentRail: "auto" }) },
      { id: "spellcheck", label: settings.spellcheck ? "Turn off spell check" : "Turn on spell check", run: () => onChangeSettings({ spellcheck: !settings.spellcheck }) },
      { id: "spell-review", label: "Review spelling", disabled: !settings.spellcheck, run: openSpellReview },
      { id: "toc", label: tocOpen ? "Hide table of contents" : "Show table of contents", run: () => setTocOpen((o) => !o) },
    ];
  }, [editor.viewRef, threads, wrapDoc, formatTableSource, hasSelection, openComposer, openSuggestionComposer, diagnostics.length, goToFirstIssue, requestPrint, settings, onChangeSettings, tocOpen, openSpellReview, commentsEdgeVisible, toggleCommentRail]);


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
      } else {
        // Not on CriticMarkup — offer spelling fixes when the click lands on a
        // misspelled word, then the comment affordance if there's a selection.
        const hit = settings.spellcheck && pos != null ? misspelledWordAt(v, pos) : null;
        if (hit) {
          if (hit.suggestions.length) {
            items.push({ header: true, label: "Suggestions" });
            for (const s of hit.suggestions) {
              // Mirror the original word's case: ALL-CAPS → all-caps, Title → Title,
              // else as-is. So "TEH"→"THE", "Teh"→"The", "teh"→"the". The all-caps
              // test compares against toUpperCase() (not a \p{Lu}+ regex) so words
              // with apostrophes — "WE'ER"→"WE'RE" — still count as all-caps.
              const insert = hit.word === hit.word.toUpperCase()
                ? s.toUpperCase()
                : /^\p{Lu}/u.test(hit.word)
                  ? s.charAt(0).toUpperCase() + s.slice(1)
                  : s;
              items.push({ label: insert, onClick: () => v.dispatch({ changes: { from: hit.from, to: hit.to, insert } }) });
            }
          } else {
            items.push({ header: true, label: "No suggestions" });
          }
          items.push({ separator: true });
          items.push({ label: "Add to dictionary", onClick: () => addWord(hit.word) });
          items.push({ label: "Ignore", onClick: () => ignoreWord(hit.word) });
        }
        if (!sel.empty) {
          if (items.length) items.push({ separator: true });
          items.push({ label: "Add comment", onClick: () => openComposer() });
          items.push({ label: "Suggest replacement", onClick: () => openSuggestionComposer() });
        }
      }
      if (items.length === 0) return; // nothing actionable — let the native menu show
      e.preventDefault();
      e.stopPropagation(); // don't let the open-menu's window closer eat this one
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [editor.viewRef, tokens, threads, acceptToken, rejectToken, resolveThread, requestReply, openComposer, openSuggestionComposer, settings.spellcheck, addWord],
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
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (editor.viewRef.current?.hasFocus || el?.isContentEditable || el?.closest(".cm-content")) {
        return;
      }

      // Plain ↓/↑ with a card selected step through the rail's cards (#43). Not
      // inside a dialog, menu or group list, where the arrows scroll or choose.
      if (
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey &&
        !el?.closest("[role=dialog], [role=menu], [data-group-ui]")
      ) {
        const selected = visibleCards.some(
          (card) => card.id === activeId || card.comments.some((c) => c.id === activeId),
        );
        const next = selected ? stepReviewCard(visibleCards, activeId, e.key === "ArrowDown" ? 1 : -1) : null;
        if (next) {
          e.preventDefault();
          if (commentRailWideEnough) focusThread(next);
          else focusMobileReviewCard(next);
        }
        return;
      }

      if (!e.altKey) return;

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
  }, [tokens, activeId, gotoToken, acceptToken, rejectToken, visibleCards, focusThread, focusMobileReviewCard, commentRailWideEnough]);

  // Cmd/Ctrl+S saves the DOCUMENT (flush the pending write) — not the browser's
  // "save page as HTML". The file is the source of truth; this is the manual save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
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
  // pairs from the document itself — see suggestCardsField.)

  // ── Mobile comment surface ────────────────────────────────────────────────────
  // On a phone the right-margin column is hidden (commentsVisible=false), so the
  // active thread/suggestion is shown in a bottom sheet instead. Navigation follows
  // the SAME filtered visible-card set as the desktop rail, including seen comments
  // when "Show seen" is enabled.
  const activeCard = useMemo<SidebarCard | null>(
    () => activeVisibleReviewCard(cards, seenThreadIds, settings.showSeen, activeId),
    [cards, seenThreadIds, settings.showSeen, activeId],
  );
  const mobileCards = useMemo(
    () => [...visibleCards].sort((a, b) => a.from - b.from),
    [visibleCards],
  );
  const nextMobileCard = useMemo(() => {
    return nextVisibleReviewCard(mobileCards, activeCard);
  }, [mobileCards, activeCard]);

  return (
    <div className="acm-workspace flex h-full flex-col bg-[var(--bg)]">
      <Header
        documentPath={documentPath}
        connected={connected}
        saveState={saveState}
        lastSavedAt={lastSavedAt}
        wordCount={wordCount}
        onWrap={wrapDoc}
        tocOpen={tocOpen}
        onToggleToc={() => setTocOpen((v) => !v)}
        commentRailVisible={commentsEdgeVisible}
        commentsSurface={commentRailWideEnough ? "rail" : "sheet"}
        onToggleCommentRail={toggleCommentRail}
        settings={settings}
        onChangeSettings={onChangeSettings}
        settingsSaveError={settingsSaveError}
        onRetrySettings={onRetrySettings}
        settingsOpen={settingsOpen}
        onSetSettingsOpen={setSettingsOpen}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onPrint={requestPrint}
        dictionary={dictionary}
        onAddWord={addWord}
        onRemoveWord={removeWord}
        flaggedCount={flagged.length}
        onOpenReview={() => {
          setSettingsOpen(false);
          openSpellReview();
        }}
        issues={{ count: diagnostics.length, fixable: fixableCount, onReview: () => setReviewOpen(true) }}
        agentControl={
          <AgentPill
            status={agentStatus}
            documentPath={documentPath}
            notifyEach={settings.notifyEachComment}
            onToggleNotifyEach={toggleNotifyEach}
            onFeedback={pushToast}
          />
        }
        toolbar={
          <FormatToolbar
            view={view}
            selectionTick={cursorLine}
            hasSelection={hasSelection}
            onAddComment={openComposer}
            onMakeSuggestion={openSuggestionComposer}
          />
        }
      />

      {/* Reading-progress bar — sits flush under the header, grows left→right as
          you scroll the document. Transparent track (nothing shows at the top of
          a doc that doesn't scroll); the accent fill is the indicator. Toggle in
          Settings → Display / the ⌘K palette. */}
      {settings.progressBar ? (
        <div className="h-[3px] shrink-0 overflow-hidden" aria-hidden="true">
          <div
            className="h-full bg-[var(--accent)]"
            style={{ width: `${readProgress * 100}%` }}
          />
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* Reading area: the editor (page) and the comment column are ONE centred
            group so comments sit just right of the page (short connectors), with the
            page background filling the outer margins. */}
        <div
          ref={readingRef}
          className={`flex min-w-0 flex-1 justify-center ${settings.page ? "bg-[var(--desk)]" : "bg-[var(--panel)]"}`}
        >
          <div
            className="grid min-w-0 transition-[grid-template-columns,max-width] duration-200 ease-out"
            style={{
              width: "100%",
              maxWidth: railExpanded ? 1100 : 780,
              gridTemplateColumns: railExpanded ? "minmax(0, 1fr) 20rem" : "minmax(0, 1fr) 0rem",
            }}
          >
            <main className="relative min-w-0 flex-1 overflow-hidden">
              <div
                ref={editor.containerRef}
                className="h-full w-full"
                onContextMenu={openEditorMenu}
                onClick={(e) => focusCommentAtPoint(e.clientX, e.clientY, e.target as HTMLElement)}
                style={
                  railExpanded && scrollReach
                    ? ({ ["--acm-scroll-reach" as string]: `${scrollReach}px` })
                    : undefined
                  }
              />
              {!composing ? (
                <SelectionActions
                  view={view}
                  selection={selectionRange}
                  onAddComment={openComposer}
                  onMakeSuggestion={openSuggestionComposer}
                  provenance={selectionProvenance}
                  provenanceLoading={selectionProvenanceLoading}
                />
              ) : null}
            </main>
            {railSurfaceMounted ? (
              <aside
                className={`min-w-0 overflow-hidden transition-opacity duration-200 ${railExpanded ? "opacity-100" : "pointer-events-none opacity-0"}`}
                aria-hidden={!railExpanded}
              >
                <div className="h-full w-80">
                  <CommentSidebar
                    view={view}
                    cards={cards}
                    richPreview={settings.richPreview}
                    activeId={activeId}
                    seenIds={seenThreadIds}
                    showSeen={settings.showSeen}
                    unseenCount={unseenCount}
                    onToggleSeen={toggleSeen}
                    repositionKey={repositionKey}
                    replyTarget={replyTarget}
                    onResolveThread={resolveThread}
                    onDeleteComment={deleteComment}
                    onEditComment={editComment}
                    onEditSuggestion={editSuggestion}
                    onReply={replyToThread}
                    onReplyAndSeen={replyAndSeen}
                    onSuggestEdit={(t, proposal) => replyAndSeen(t, `SUGGEST: ${proposal}`)}
                    onAskAgent={(t) => {
                      replyAndSeen(t, EDIT_REQUEST_TEXT);
                      const feedback = askFeedback(agentStatus);
                      pushToast(feedback.message, feedback.kind);
                    }}

                    anchoredCardIds={anchoredCardIds}
                    onApplySuggestion={(c) =>
                      runSuggestionEdit(
                        c,
                        "accept",
                        defaultApplyDiscussion,
                      )
                    }
                    onApplyAndResolveSuggestion={(c) =>
                      runSuggestionEdit(c, "accept", "resolve-thread")
                    }
                    onRejectSuggestionEdit={(c) => runSuggestionEdit(c, "reject")}
                    applicableSuggestionIds={applicableSuggestionIds}
                    suggestionAnchorTextById={suggestionAnchorTextById}
                    groupOf={groupOf}
                    groupMembersOf={groupMembersOf}
                    groupNotesOf={groupNotesOf}
                    onGroupResolveNotes={resolveNoteGroup}
                    onGroupEdit={(groupId, mode, unticked) =>
                      runGroupEdit(
                        groupId,
                        mode,
                        mode === "accept" ? defaultApplyDiscussion : "keep-discussion",
                        unticked,
                      )
                    }
                    onGroupApplyAndResolve={(groupId, unticked) =>
                      runGroupEdit(groupId, "accept", "resolve-thread", unticked)
                    }
                    onLocate={locateSpan}
                    onAcceptSuggestion={(c) => c.kind === "suggestion" && acceptToken(c.suggestion)}
                    onRejectSuggestion={(c) => c.kind === "suggestion" && rejectToken(c.suggestion)}
                    onFocusThread={focusThread}
                    onCardContextMenu={openCommentMenu}
                    composerOpen={composing}
                    composerKind={composerKind}
                    composerDraft={draft}
                    composerAnchored={composerAnchored}
                    onComposerDraftChange={setDraft}
                    onPostComment={() => postComment(false)}
                    onPostCommentSeen={() => postComment(true)}
                    onCancelComposer={cancelComposer}
                    onContentExtent={(px) => setScrollReach((p) => (Math.abs(p - px) > 2 ? px : p))}
                  />
                </div>
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
      ) : null}

      {paletteOpen ? <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} /> : null}

      {/* Mobile: the right-margin column is hidden (too narrow), so the active
          thread/suggestion lives in a bottom sheet, with a floating entry button
          to open the first unseen comment when nothing's focused. */}
      {!commentRailWideEnough && composing ? (
        <MobileCommentComposer
          kind={composerKind}
          draft={draft}
          anchored={composerAnchored}
          onDraftChange={setDraft}
          onPost={() => postComment(false)}
          onPostDone={() => postComment(true)}
          onCancel={cancelComposer}
        />
      ) : null}
      {!commentRailWideEnough && !composing && hasVisibleCards && settings.commentRail !== "hide" ? (
        <>
          <MobileCommentSheet
            active={activeCard}
            activeSeen={activeCard?.kind === "comment" && seenThreadIds.has(activeCard.id)}
            unseenCount={unseenCount}
            richPreview={settings.richPreview}
            nextOpen={nextMobileCard}
            onClose={() => setActiveId(null)}
            onGoTo={focusMobileReviewCard}
            onReply={replyToThread}
            onReplyAndSeen={replyAndSeen}
            onResolveThread={resolveThread}
            onEditComment={editComment}
            onEditSuggestion={editSuggestion}
            onSuggestEdit={(t, proposal) => replyAndSeen(t, `SUGGEST: ${proposal}`)}
            onToggleSeen={toggleSeen}
            onApplySuggestion={(c) =>
              runSuggestionEdit(
                c,
                "accept",
                defaultApplyDiscussion,
              )
            }
            onApplyAndResolveSuggestion={(c) =>
              runSuggestionEdit(c, "accept", "resolve-thread")
            }
            onRejectSuggestionEdit={(c) => runSuggestionEdit(c, "reject")}
            applicableSuggestionIds={applicableSuggestionIds}
            suggestionAnchorTextById={suggestionAnchorTextById}
            onAcceptSuggestion={(c) => c.kind === "suggestion" && acceptToken(c.suggestion)}
            onRejectSuggestion={(c) => c.kind === "suggestion" && rejectToken(c.suggestion)}
          />
          {!activeCard && mobileCards.length > 0 ? (
            <button
              type="button"
              onClick={() => nextMobileCard && focusMobileReviewCard(nextMobileCard)}
              className="fixed bottom-3 left-3 z-30 flex items-center gap-1.5 rounded-full bg-[var(--accent)] py-2 pl-3 pr-3.5 text-[13px] font-medium text-[var(--panel)] shadow-lg"
              title="Open comments"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              {mobileReviewEntryLabel(mobileCards.length, unseenCount)}
            </button>
          ) : null}
        </>
      ) : null}

      {shortcutsOpen ? <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} /> : null}
      {spellReviewOpen ? (
        <SpellingReview
          words={flagged}
          suggest={suggestFor}
          onFix={fixSpelling}
          onAdd={addWord}
          onIgnore={ignoreWord}
          onClose={() => setSpellReviewOpen(false)}
        />
      ) : null}

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      <ToastStack toasts={toasts} />
      <PrintDocument
        result={printResult}
        style={settings.printStyle}
        alternateSides={settings.printAlternateSides}
      />
    </div>
  );
}
