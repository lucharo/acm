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
import CommentSidebar, { MOD, handleCommentKey } from "./components/CommentSidebar";
import HealReview from "./components/HealReview";
import Toc from "./components/Toc";
import NavPanel from "./components/NavPanel";
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

type Theme = "light" | "dark";
type Font = "serif" | "sans" | "mono";
interface ViewSettings {
  theme: Theme;
  font: Font;
  page: boolean; // A4-style page view (document as a sheet on a desk)
  lineNumbers: boolean;
  bionic: boolean; // bionic-reading: bold the lead of each word (rendered only)
  showSeen: boolean; // reveal comments marked "seen" (off = they're hidden, zero-inbox)
  author: string; // name stamped on comments YOU add through the UI
}
const FONT_STACKS: Record<Font, string> = {
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  sans: 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};
const FONT_LABELS: Record<Font, string> = { serif: "Serif", sans: "Sans", mono: "Mono" };

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

interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}
interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}
const DEFAULT_SETTINGS: ViewSettings = {
  theme: "light",
  font: "serif",
  page: true,
  lineNumbers: false,
  bionic: false,
  showSeen: false,
  author: "You",
};
function loadSettings(): ViewSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("acm-settings") ?? "{}") };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// ── "Seen" comment tracking (declutter between review rounds) ──────────────────
// "Seen" is a lightweight, NON-destructive state (unlike Resolve, which strips the
// markup from the file). It lives client-side in localStorage, keyed by comment
// CONTENT (author+body) so it survives the positional-id shifts that edits cause —
// the file is never touched.
function commentKey(c: { author: string | null; body: string }): string {
  // NUL separator (written as an escape, not a raw byte: a raw NUL makes every
  // tool treat this file as binary): un-typeable, so "a b"+"c" can never collide
  // with "a"+"b c". The escape keeps the exact runtime string - stored seen-keys
  // (localStorage + ~/.config/acm) stay valid.
  return `${c.author ?? ""}\u0000${c.body}`;
}
// (wrappableSpan — whether a selection can become a `{==span==}` anchor — lives in
// lib/criticmarkup so the composer and the `acm suggest` verb share one gate.)
function loadSeen(): Set<string> {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem("acm-seen") ?? "[]"));
  } catch {
    return new Set();
  }
}

// ── Server-side config sync (~/.config/acm/settings.json) ──────────────────────
// localStorage stays the INSTANT cache (theme/font apply with no fetch flash); the
// server file is the cross-instance source of truth. Each writer PUTs only its own
// key (settings | seen) and the server merges, so they never clobber each other.
async function fetchConfig(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch("/api/settings");
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
function putConfig(patch: Record<string, unknown>): void {
  void fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => {});
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

  // View settings live here so theme/font apply to the loading screen too. Initialised
  // from localStorage (instant, no flash) and reconciled with the server file below.
  const [settings, setSettings] = useState<ViewSettings>(loadSettings);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.setProperty("--editor-font", FONT_STACKS[settings.font]);
    localStorage.setItem("acm-settings", JSON.stringify(settings));
  }, [settings]);
  const onChangeSettings = useCallback(
    (patch: Partial<ViewSettings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );
  // On mount: adopt the server's settings (cross-instance truth); if it has none,
  // migrate this browser's localStorage settings up to the server. Gate the sync
  // PUT until after this so we don't clobber the server before reading it.
  const settingsHydrated = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void fetchConfig().then((cfg) => {
      if (cancelled) return;
      if (cfg && cfg.settings) setSettings((s) => ({ ...s, ...(cfg.settings as Partial<ViewSettings>) }));
      else putConfig({ settings: loadSettings() }); // first run → migrate
      settingsHydrated.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!settingsHydrated.current) return;
    const t = setTimeout(() => putConfig({ settings }), 300);
    return () => clearTimeout(t);
  }, [settings]);

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
  const [contentMin, setContentMin] = useState(0);

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

  // Selection state powers the "Add comment" affordance.
  const [hasSelection, setHasSelection] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  // Whether the captured selection can anchor as a `{==span==}` (vs falling back to
  // a point comment) — surfaced in the composer so the fallback is never silent.
  const [composerAnchored, setComposerAnchored] = useState(true);
  const commentAnchor = useRef<number | null>(null);
  // Full selection range captured when the composer opens, so a comment can anchor to
  // the SPAN (wrapping it in `{==…==}`), not just a point — set in openComposer.
  const commentRange = useRef<{ from: number; to: number } | null>(null);

  const tokens = useMemo(() => scanTokens(doc), [doc]);
  const wordCount = useMemo(() => countWords(doc), [doc]);
  // Markdown headings → the floating outline (TOC). Strip any inline CriticMarkup
  // from the displayed text; `from` is the heading line's doc offset (jump target).
  const headings = useMemo(() => {
    const out: { level: number; text: string; from: number }[] = [];
    const re = /^(#{1,6})[ \t]+(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(doc)) !== null) {
      const text = m[2]
        .replace(/\{>>[\s\S]*?<<\}/g, "")
        .replace(/\{(\+\+|--|~~|==)|(\+\+|--|~~|==)\}|~>/g, "")
        .trim();
      out.push({ level: m[1].length, text, from: m.index });
    }
    return out;
  }, [doc]);
  const comments = useMemo(() => tokens.filter(isComment), [tokens]);
  // Adjacent comments grouped into threaded cards (root + replies).
  const threads = useMemo(() => groupThreads(comments, doc), [comments, doc]);
  // The full margin set: comment threads + suggestion cards (with adjacent replies),
  // ordered by offset. Drives the sidebar.
  const cards = useMemo(() => groupCards(tokens, doc), [tokens, doc]);
  // Comment-kind cards only — for seen/unseen accounting (suggestions are accept/
  // reject, not "seen", and shouldn't inflate the inbox).
  const commentCards = useMemo(() => cards.filter((c) => c.kind === "comment"), [cards]);
  // The anchored SUGGEST: pairs — ONE pass over the already-memoized tokens, feeding
  // both the editor's inline accept/reject layer and the sidebar's Apply gate. The
  // gate is just their ids, so "what's applyable" can't drift between the two.
  const inlineSuggestionList = useMemo(() => inlineSuggestions(doc, tokens), [doc, tokens]);
  const applicableSuggestionIds = useMemo(
    () => new Set(inlineSuggestionList.map((s) => s.commentId)),
    [inlineSuggestionList],
  );

  // "Seen" tracking — content-keyed, non-destructive. localStorage is the instant
  // cache; ~/.config/acm/settings.json is the cross-instance truth (synced below).
  const [seen, setSeen] = useState<Set<string>>(loadSeen);
  useEffect(() => {
    localStorage.setItem("acm-seen", JSON.stringify([...seen]));
  }, [seen]);
  // On mount: adopt the server's seen set, or migrate localStorage up on first run.
  const seenHydrated = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void fetchConfig().then((cfg) => {
      if (cancelled) return;
      if (cfg && Array.isArray(cfg.seen)) setSeen(new Set(cfg.seen as string[]));
      else putConfig({ seen: [...loadSeen()] });
      seenHydrated.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!seenHydrated.current) return;
    const t = setTimeout(() => putConfig({ seen: [...seen] }), 300);
    return () => clearTimeout(t);
  }, [seen]);
  const seenThreadIds = useMemo(
    () =>
      new Set(
        commentCards.filter((t) => t.comments.every((c) => seen.has(commentKey(c)))).map((t) => t.id),
      ),
    [commentCards, seen],
  );
  // Unseen comment threads remaining (drives the zero-inbox counter).
  const unseenCount = useMemo(
    () => commentCards.filter((t) => !t.comments.every((c) => seen.has(commentKey(c)))).length,
    [commentCards, seen],
  );

  // Doc health: comments accidentally inserted INSIDE another comment's body
  // (nested `{>>…{>>…<<}…<<}`) — they render raw and split words. Each is
  // auto-healable (pull the inner one out into an adjacent comment).
  const healIssues = useMemo(() => nestedCommentIssues(doc), [doc]);
  // ALL markup defects — every delimiter that renders raw (leaking highlights,
  // dangling opens, stray closes, malformed comments), as positioned diagnostics
  // (#18). Drives the warning pill; healIssues is the auto-healable subset.
  const diagnostics = useMemo(() => validateMarkup(doc), [doc]);
  // How many of those one click can repair: simulate the full heal and diff the
  // counts (covers nested comments, trapped comments, multi-block anchors).
  const fixableCount = useMemo(
    () => (diagnostics.length === 0 ? 0 : diagnostics.length - validateMarkup(healDocument(doc)).length),
    [doc, diagnostics.length],
  );

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
  });

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

  // commentId → its suggestion group (id + member count), for the sidebar's
  // group-wide Apply/Reject controls. Only real groups (≥2 members) qualify.
  const suggestionGroupOf = useMemo(() => {
    const map = new Map<string, { id: string; size: number }>();
    for (const s of inlineSuggestionList) {
      if (s.groupId && s.groupSize > 1) map.set(s.commentId, { id: s.groupId, size: s.groupSize });
    }
    return map;
  }, [inlineSuggestionList]);

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
  // comment — anything the validator flags).
  const goToFirstIssue = useCallback(() => {
    const v = editor.viewRef.current;
    if (!v) return;
    const first = validateMarkup(v.state.doc.toString())[0];
    if (first) v.dispatch({ effects: EditorView.scrollIntoView(first.from, { y: "center" }) });
  }, [editor.viewRef]);

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

  // ── Add a comment from the current selection ──────────────────────────────────
  const openComposer = useCallback(() => {
    const v = editor.viewRef.current;
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
  }, [editor.viewRef]);

  const postComment = useCallback(
    // markSeen (⌘⇧↵): post the comment and immediately mark it seen — the
    // "suggest edits" flow where you've said your piece and want it out of your
    // own inbox. Marks only the NEW comment (found by its post-insert offset), so
    // if it joined an existing thread the others stay open.
    (markSeen = false) => {
      const v = editor.viewRef.current;
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
        const marker = open + formatComment(settings.author, text);
        v.dispatch({ changes: { from: range.from, to: range.to, insert: marker } });
        commentStart = range.from + open.length; // the `{>>` lands right after the highlight
      } else {
        const raw = range ? range.to : commentAnchor.current!;
        const at = clampAnchorOutsideComments(content, Math.max(0, Math.min(raw, content.length)));
        const prev = at > 0 ? content.slice(at - 1, at) : "";
        const lead = at > 0 && !/\s/.test(prev) ? " " : "";
        v.dispatch({ changes: { from: at, insert: lead + formatComment(settings.author, text) } });
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
    [draft, editor.viewRef, settings.author],
  );

  // One-click "Suggest edit" on the current selection: anchor a canned "suggest edit"
  // comment at the selection + mark it seen, handing the span to the agent — no
  // composer, no typing. Mirrors postComment's anchor/clamp logic.
  const suggestEditOnSelection = useCallback(() => {
    const v = editor.viewRef.current;
    if (!v) return;
    const sel = v.state.selection.main;
    if (sel.empty) return;
    const content = v.state.doc.toString();
    const at = clampAnchorOutsideComments(content, Math.max(0, Math.min(sel.to, content.length)));
    const prev = at > 0 ? content.slice(at - 1, at) : "";
    const lead = at > 0 && !/\s/.test(prev) ? " " : "";
    v.dispatch({ changes: { from: at, insert: lead + formatComment(settings.author, SUGGEST_EDIT_TEXT) } });
    const fresh = scanTokens(v.state.doc.toString())
      .filter(isComment)
      .find((c) => c.from === at + lead.length);
    if (fresh) setSeen((p) => new Set(p).add(commentKey(fresh)));
  }, [editor.viewRef, settings.author]);

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
                  commentsVisible && contentMin
                    ? ({ ["--acm-scroll-reach" as string]: `${contentMin}px` })
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
                  onContentExtent={(px) => setContentMin((p) => (Math.abs(p - px) > 2 ? px : p))}
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

interface HeaderProps {
  connected: boolean;
  saveState: SaveState;
  lastSavedAt: number | null;
  wordCount: number;
  canComment: boolean;
  composing: boolean;
  composerAnchored: boolean;
  onWrap: () => void;
  draft: string;
  onDraftChange: (v: string) => void;
  onOpenComposer: () => void;
  onPostComment: () => void;
  /** Post the comment AND mark it seen — the "suggest edits & dismiss" flow (⌘⇧↵). */
  onPostCommentSeen: () => void;
  /** One-click: post a canned "suggest edit" comment on the selection + mark it seen. */
  onSuggestEdit: () => void;
  onCancelComposer: () => void;
  navOpen: boolean;
  onToggleNav: () => void;
  tocOpen: boolean;
  onToggleToc: () => void;
  settings: ViewSettings;
  onChangeSettings: (patch: Partial<ViewSettings>) => void;
}

const iconBtn =
  "flex h-7 w-7 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)]";

function Header(props: HeaderProps) {
  const {
    connected,
    saveState,
    lastSavedAt,
    wordCount,
    canComment,
    composing,
    composerAnchored,
    onWrap,
    draft,
    onDraftChange,
    onOpenComposer,
    onPostComment,
    onPostCommentSeen,
    onSuggestEdit,
    onCancelComposer,
    navOpen,
    onToggleNav,
    tocOpen,
    onToggleToc,
    settings,
    onChangeSettings,
  } = props;

  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="relative flex min-h-12 shrink-0 items-center gap-2 border-b border-[var(--line)] bg-[var(--panel)] px-3 py-1.5">
      {/* Overview-panel toggle */}
      <button
        type="button"
        onClick={onToggleNav}
        className={`${iconBtn} ${navOpen ? "bg-[var(--line)] text-[var(--ink)]" : ""}`}
        title={navOpen ? "Hide overview" : "Show overview"}
        aria-pressed={navOpen}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>

      {/* Outline (table of contents) toggle */}
      <button
        type="button"
        onClick={onToggleToc}
        className={`${iconBtn} ${tocOpen ? "bg-[var(--line)] text-[var(--ink)]" : ""}`}
        title={tocOpen ? "Hide outline" : "Show outline"}
        aria-pressed={tocOpen}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <line x1="3" y1="4" x2="13" y2="4" />
          <line x1="5" y1="8" x2="13" y2="8" />
          <line x1="7" y1="12" x2="13" y2="12" />
        </svg>
      </button>

      <img src="/logo.png" alt="" className="h-5 w-5 shrink-0 rounded-[4px]" />
      <span className="text-[13px] font-semibold tracking-tight">
        ACM <span className="text-[var(--faint)]">· Agent CriticMarkup</span>
      </span>

      <div className="ml-auto flex items-center gap-2">
        {composing ? (
          <div className="flex items-center gap-1.5">
            <textarea
              autoFocus
              rows={1}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => handleCommentKey(e, onPostComment, onPostCommentSeen, onCancelComposer)}
              placeholder="Comment on selection…  (⇧↵ for a new line)"
              className="block max-h-32 w-60 resize-none overflow-y-auto rounded border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-1 text-[13px] leading-relaxed text-[var(--ink)] outline-none [field-sizing:content] focus:border-[var(--accent)]"
            />
            {!composerAnchored && (
              /* The selection can't be wrapped as a {==span==} (it cuts markup or
                 crosses a paragraph) — disclose the point fallback instead of
                 silently degrading. */
              <span
                className="max-w-24 text-[10px] italic leading-tight text-[var(--muted)]"
                title="This selection crosses markup or a paragraph break, so the comment will attach at its end point instead of anchoring the span."
              >
                attaches at a point — selection can't anchor
              </span>
            )}
            <button
              type="button"
              onClick={onPostComment}
              className="flex items-center gap-1.5 rounded bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-[var(--panel)]"
            >
              Post <span className="text-[10px] font-normal opacity-70">{MOD}↵</span>
            </button>
            <button
              type="button"
              onClick={onPostCommentSeen}
              title="Post and mark it seen"
              className="flex items-center gap-1.5 rounded border border-[var(--line-strong)] px-2 py-1 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--line)]"
            >
              &amp; seen <span className="text-[10px] font-normal text-[var(--faint)]">{MOD}⇧↵</span>
            </button>
            <button
              type="button"
              onClick={onCancelComposer}
              className="rounded px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--line)]"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onOpenComposer}
            disabled={!canComment}
            title={canComment ? "Comment on selection" : "Select text to comment"}
            className="rounded border border-[var(--line-strong)] px-2.5 py-1 text-[12px] font-medium text-[var(--ink)] enabled:hover:bg-[var(--line)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add comment
          </button>
        )}
        {/* One-click hand-off: tag the selection with a "suggest edit" comment for the
            agent + mark it seen. Only when there's a selection and not mid-compose. */}
        {!composing && canComment ? (
          <button
            type="button"
            onClick={onSuggestEdit}
            title="Ask the agent for an edit on this selection — posts “suggest edit” and marks it seen"
            className="flex items-center gap-1 rounded border border-[var(--line-strong)] px-2.5 py-1 text-[12px] font-medium text-[var(--crit-comment)] hover:bg-[var(--line)]"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            Suggest edit
          </button>
        ) : null}

        <span className="text-[11px] tabular-nums text-[var(--faint)]" title="Word count (accepted prose)">
          {wordCount.toLocaleString()} words
        </span>

        <SaveBadge state={saveState} lastSavedAt={lastSavedAt} />

        <span
          className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]"
          title={connected ? "Live — watching the file" : "Disconnected"}
        >
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: connected ? "var(--crit-ins)" : "var(--crit-del)" }}
          />
          {connected ? "live" : "offline"}
        </span>

        {/* Settings (a proper cog) */}
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          className={`${iconBtn} ${settingsOpen ? "bg-[var(--line)] text-[var(--ink)]" : ""}`}
          title="Settings"
          aria-haspopup="menu"
          aria-expanded={settingsOpen}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>

        {settingsOpen ? (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setSettingsOpen(false)} />
            <div className="absolute right-3 top-11 z-30 w-60 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1.5 shadow-lg">
              <FontPicker value={settings.font} onChange={(font) => onChangeSettings({ font })} />
              <div className="my-1 border-t border-[var(--line)]" />
              <div className="px-2 py-1.5">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--faint)]">
                  Your name (on comments you add)
                </div>
                <input
                  value={settings.author}
                  onChange={(e) => onChangeSettings({ author: e.target.value })}
                  placeholder="You"
                  className="w-full rounded-md border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                />
              </div>
              <div className="my-1 border-t border-[var(--line)]" />
              <SettingRow
                label="Dark mode"
                checked={settings.theme === "dark"}
                onToggle={() => onChangeSettings({ theme: settings.theme === "dark" ? "light" : "dark" })}
              />
              <SettingRow
                label="Page view"
                checked={settings.page}
                onToggle={() => onChangeSettings({ page: !settings.page })}
              />
              <SettingRow
                label="Line numbers"
                checked={settings.lineNumbers}
                onToggle={() => onChangeSettings({ lineNumbers: !settings.lineNumbers })}
              />
              <SettingRow
                label="Bionic reading"
                checked={settings.bionic}
                onToggle={() => onChangeSettings({ bionic: !settings.bionic })}
              />
              <SettingRow
                label="Show seen comments"
                checked={settings.showSeen}
                onToggle={() => onChangeSettings({ showSeen: !settings.showSeen })}
              />
              <SettingRow label="Overview panel" checked={navOpen} onToggle={onToggleNav} />
              <div className="my-1 border-t border-[var(--line)]" />
              <button
                type="button"
                onClick={() => {
                  setSettingsOpen(false);
                  onWrap();
                }}
                title="Reflow prose to 88 columns. Markup-safe (never splits a comment or suggestion) and undoable. Also in the ⌘K palette, or `acm wrap` from the shell."
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--ink)] hover:bg-[var(--line)]"
              >
                Hard-wrap prose <span className="text-[11px] text-[var(--faint)]">88 cols · ⌘K</span>
              </button>
              <div className="my-1 border-t border-[var(--line)]" />
              <div className="px-2 py-1.5">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--faint)]">
                  Agent-review skill
                </div>
                <p className="text-[11px] leading-snug text-[var(--muted)]">
                  Run <code className="rounded bg-[var(--line)] px-1 text-[var(--ink)]">acm skill</code> to
                  install, then edit{" "}
                  <code className="rounded bg-[var(--line)] px-1 text-[var(--ink)]">~/.agents/skills/acm-review/SKILL.md</code>{" "}
                  to customize how agents review.
                </p>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </header>
  );
}

function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", onClose);
    window.addEventListener("contextmenu", onClose);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("click", onClose);
      window.removeEventListener("contextmenu", onClose);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  const width = 184;
  const x = Math.min(menu.x, window.innerWidth - width - 8);
  const y = Math.min(menu.y, window.innerHeight - (menu.items.length * 34 + 12));
  return (
    <div
      className="fixed z-50 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1 shadow-lg"
      style={{ left: x, top: y, width }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
    >
      {menu.items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          onClick={() => {
            it.onClick();
            onClose();
          }}
          className={`flex w-full items-center rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--line)] ${
            it.danger ? "text-[var(--crit-del)]" : "text-[var(--ink)]"
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function FontPicker({ value, onChange }: { value: Font; onChange: (f: Font) => void }) {
  return (
    <div className="px-2 py-1.5">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--faint)]">
        Document font
      </div>
      <div className="flex gap-1">
        {(["serif", "sans", "mono"] as Font[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => onChange(f)}
            className={`flex-1 rounded px-2 py-1 text-[13px] transition-colors ${
              value === f
                ? "bg-[var(--accent)] text-[var(--panel)]"
                : "text-[var(--muted)] hover:bg-[var(--line)]"
            }`}
            style={{ fontFamily: FONT_STACKS[f] }}
          >
            {FONT_LABELS[f]}
          </button>
        ))}
      </div>
    </div>
  );
}

function SettingRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded px-2 py-1.5 text-[13px] text-[var(--ink)] hover:bg-[var(--line)]"
      role="menuitemcheckbox"
      aria-checked={checked}
    >
      <span>{label}</span>
      <span
        className={`relative h-4 w-7 rounded-full transition-colors ${
          checked ? "bg-[var(--crit-ins)]" : "bg-[var(--line-strong)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            checked ? "left-3.5" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

const SAVE_BADGE: Record<SaveState, { label: string; color: string; title: string }> = {
  saved: { label: "Saved", color: "var(--muted)", title: "All changes saved to disk" },
  saving: { label: "Saving…", color: "var(--muted)", title: "Writing to disk…" },
  unsaved: { label: "Unsaved", color: "var(--crit-ins)", title: "Edits queued — saving shortly (⌘S to save now)" },
  offline: { label: "Offline · unsaved", color: "var(--crit-del)", title: "Disconnected — your edits are held and will be written on reconnect" },
  conflict: { label: "Conflict", color: "var(--crit-del)", title: "The file changed under your edit; your version is kept and will be saved" },
};

/** Explicit Saved / Saving / Unsaved / Offline / Conflict indicator. When saved,
 *  shows the wall-clock time of the last write (HH:MM:SS) for the paranoid. */
function SaveBadge({ state, lastSavedAt }: { state: SaveState; lastSavedAt: number | null }) {
  const s = SAVE_BADGE[state];
  const label =
    state === "saved" && lastSavedAt
      ? `Saved ${new Date(lastSavedAt).toLocaleTimeString([], { hour12: false })}`
      : s.label;
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] tabular-nums"
      style={{ color: s.color }}
      title={state === "saved" && lastSavedAt ? `Last written to disk at ${new Date(lastSavedAt).toLocaleTimeString()}` : s.title}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: s.color, opacity: state === "saved" ? 0.5 : 1 }}
      />
      {label}
    </span>
  );
}
