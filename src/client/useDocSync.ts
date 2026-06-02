// ── useDocSync — the browser side of ACM's live file sync ─────────────────────
// On mount it fetches the document snapshot, opens a WebSocket to the Bun server
// for external-change pushes, and exposes a debounced, version-checked `save`.
//
// State-based, never delta-based: every push (and every reconnect re-GET) carries
// the full document + a monotonic version, so a dropped connection just resyncs
// from a fresh snapshot — there is no event replay to miss.
//
// The client always talks to RELATIVE paths (/api, /ws) so the same code works in
// dev (Vite proxies to :8787) and prod (Bun serves on one port).

import { useCallback, useEffect, useRef, useState } from "react";
import type { DocState, ServerMessage } from "../lib/types";

interface UseDocSyncOptions {
  /**
   * Called when the document changes outside this editor: an external file edit
   * (WS push), a reconnect resync, or a 409 conflict on save. The App rebases the
   * editor onto `content` (scroll-preserving) and adopts `version`.
   */
  onRemoteUpdate: (content: string, version: number) => void;
}

/**
 * Persisted-state of the local buffer relative to disk:
 *   saved    — buffer matches the last successful write
 *   unsaved  — local edits queued, save debouncing
 *   saving   — a write is in flight
 *   offline  — disconnected; edits are held and WILL be written on reconnect
 *   conflict — the file changed underneath an unsaved local edit (e.g. an agent
 *              wrote concurrently); local edits are KEPT, not discarded
 */
export type SaveState = "saved" | "unsaved" | "saving" | "offline" | "conflict";

interface UseDocSyncResult {
  initialDoc: string | null;
  initialVersion: number;
  connected: boolean;
  /** Persisted-state of the buffer, for an explicit save indicator. */
  saveState: SaveState;
  /** Epoch ms when the buffer last became consistent with disk (null until first). */
  lastSavedAt: number | null;
  /** Debounced, version-checked write of the full document to disk. */
  save: (content: string) => void;
  /** Flush any pending save immediately (Cmd/Ctrl+S, blur, page hide). */
  flushNow: () => void;
}

const SAVE_DEBOUNCE_MS = 500;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export function useDocSync(opts: UseDocSyncOptions): UseDocSyncResult {
  const [initialDoc, setInitialDoc] = useState<string | null>(null);
  const [initialVersion, setInitialVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // Read-only mirror of `connected` for callbacks that must not re-subscribe.
  const connectedRef = useRef(false);
  connectedRef.current = connected;

  // The version the client believes the server holds — the basis for the next
  // PUT and the value adopted from every push/409. A ref so the debounced save
  // closure always reads the latest value without re-subscribing.
  const currentVersion = useRef(0);

  // Latest content queued for save, plus the debounce timer.
  const pendingContent = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // WebSocket + reconnect machinery.
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(RECONNECT_MIN_MS);
  const mounted = useRef(true);

  // Keep the latest callback in a ref so the socket lifecycle effect runs once.
  const onRemoteUpdate = useRef(opts.onRemoteUpdate);
  onRemoteUpdate.current = opts.onRemoteUpdate;

  const adoptRemote = useCallback((content: string, version: number) => {
    // Only adopt strictly-NEWER server states. A reconnect-resync GET can resolve
    // after a newer WS push (or arrive stale/equal); applying it would regress the
    // editor. Guard before any side effect.
    if (version <= currentVersion.current) return;

    // DATA-INTEGRITY RULE: never rebase over UNSAVED local edits. If the buffer has
    // pending changes the user hasn't seen persisted, adopting remote content here
    // would silently discard their work (the old behaviour — a real source of lost
    // edits). Instead, KEEP the local buffer, flag a conflict, and let the pending
    // save flush; the user keeps their text and gets a visible signal. We only adopt
    // remote content when there's nothing unsaved to lose.
    if (pendingContent.current !== null) {
      setSaveState("conflict");
      return;
    }
    currentVersion.current = version;
    onRemoteUpdate.current(content, version);
    setSaveState("saved");
    setLastSavedAt(Date.now());
  }, []);

  // ── Mount: initial snapshot + WebSocket with reconnect ──────────────────────
  useEffect(() => {
    mounted.current = true;

    const fetchSnapshot = async () => {
      const res = await fetch("/api/doc");
      const { content, version } = (await res.json()) as DocState;
      // NB: do NOT mutate currentVersion here — adoptRemote is the single,
      // monotonic writer (except the initial baseline below). A bare set here
      // would let a late stale GET regress the baseline past adoptRemote's guard.
      return { content, version };
    };

    // Initial load populates the editor and sets the version baseline (first GET,
    // so no race with adoptRemote yet).
    fetchSnapshot().then(({ content, version }) => {
      if (!mounted.current) return;
      currentVersion.current = version;
      setInitialDoc(content);
      setInitialVersion(version);
    });

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${scheme}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mounted.current) return;
        connectedRef.current = true; // sync — so the reconnect flush below sees us online
        setConnected(true);
        reconnectDelay.current = RECONNECT_MIN_MS;
        if (pendingContent.current !== null) {
          // Edits made while offline: persist them now (adoptRemote won't clobber
          // pending, so a resync can't drop them). This is the reconnect save path.
          flushRef.current();
        } else {
          // No local edits pending → safe to resync to the file (state-based, no replay).
          fetchSnapshot().then(({ content, version }) => {
            if (mounted.current) adoptRemote(content, version);
          });
        }
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        if (msg.type === "update") adoptRemote(msg.content, msg.version);
      };

      ws.onclose = () => {
        if (!mounted.current) return;
        connectedRef.current = false;
        setConnected(false);
        if (pendingContent.current !== null) setSaveState("offline"); // edits held until reconnect
        reconnectTimer.current = setTimeout(connect, reconnectDelay.current);
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, RECONNECT_MAX_MS);
      };
    };

    connect();

    return () => {
      mounted.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null; // don't schedule a reconnect on intentional teardown
        ws.close();
      }
    };
  }, [adoptRemote]);

  // ── Debounced, version-checked save ─────────────────────────────────────────
  // Pending content is cleared ONLY on a confirmed write — never optimistically —
  // so a failed/offline/conflicting save always retains the user's edits.
  const flush = useCallback(async () => {
    const content = pendingContent.current;
    if (content === null) return;
    if (!connectedRef.current) {
      setSaveState("offline"); // held; flushed on reconnect (onopen below)
      return;
    }
    setSaveState("saving");
    let res: Response;
    try {
      res = await fetch("/api/doc", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, baseVersion: currentVersion.current }),
      });
    } catch {
      setSaveState("offline"); // network blip — keep pending, retry on reconnect
      return;
    }

    if (res.status === 409) {
      // The file changed underneath us (e.g. an agent wrote concurrently). Do NOT
      // discard the user's edits. Adopt the server's VERSION so the retry has a
      // valid baseVersion, KEEP the local content, flag the conflict, and re-flush
      // so the user's version persists (user wins; a concurrent edit in this narrow
      // window may be overwritten — surfaced via the 'conflict' status).
      const { version } = (await res.json()) as DocState;
      currentVersion.current = version;
      setSaveState("conflict");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
      return;
    }

    const { version } = (await res.json()) as { version: number };
    currentVersion.current = version;
    if (pendingContent.current === content) {
      pendingContent.current = null; // confirmed written
      setSaveState("saved");
      setLastSavedAt(Date.now());
    } else {
      // Newer keystrokes arrived mid-flight; persist them on the next tick.
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    }
  }, []);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const save = useCallback((content: string) => {
    // Coalesce rapid calls: always send the latest content on the next fire.
    pendingContent.current = content;
    setSaveState(connectedRef.current ? "unsaved" : "offline");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flushRef.current(), SAVE_DEBOUNCE_MS);
  }, []);

  // Flush immediately (Cmd/Ctrl+S, blur, page hide) — cancel the debounce first.
  const flushNow = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    void flushRef.current();
  }, []);

  // Persist pending edits when the tab loses focus / is hidden / is closing, so a
  // mid-debounce edit can't be stranded if the window goes away.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    window.addEventListener("blur", flushNow);
    window.addEventListener("beforeunload", flushNow);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("blur", flushNow);
      window.removeEventListener("beforeunload", flushNow);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [flushNow]);

  return { initialDoc, initialVersion, connected, saveState, lastSavedAt, save, flushNow };
}
