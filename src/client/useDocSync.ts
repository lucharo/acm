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
import {
  decisionEventsAcknowledged,
  isDecisionEvent,
  type DecisionEvent,
  type DecisionQueueUpdate,
} from "../lib/decision";
import {
  decisionOutboxEvents,
  loadDecisionOutboxState,
  markDecisionOutboxCommitted,
  mergeCommittedDecisionOutbox,
  mergeDecisionOutbox,
  reconcileDeferredDecisionOutbox,
  rebasePendingDecisionOutbox,
  removeDecisionOutboxEvents,
  storeDecisionOutbox,
  type DecisionOutboxEntry,
} from "./decisionOutbox";
import { KEEP_VERSIONS, merge3 } from "../lib/merge";
import { reconcileSave } from "./reconcile";

interface UseDocSyncOptions {
  /** Human identity attached to each persisted edit. */
  author: string;
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
export type SaveState =
  | "saved"
  | "unsaved"
  | "saving"
  | "offline"
  | "conflict"
  | "audit-error"
  | "audit-recovery";

/** A refresh or close starts a save of the pending buffer on the way out, but
 * the browser may cancel that request (and offline there is none), so unsaved
 * edits ask the browser's Leave-site prompt until a write confirms them (#31). */
export function unloadWouldLoseEdits(pendingContent: string | null): boolean {
  return pendingContent !== null;
}

/** Selection offsets are meaningful to the server only while the live editor
 * buffer is byte-for-byte aligned with the persisted document. */
export function canQuerySelectionProvenance(
  saveState: SaveState,
  connected: boolean,
): boolean {
  return connected && saveState === "saved";
}

interface UseDocSyncResult {
  initialDoc: string | null;
  initialVersion: number;
  documentPath: string | null;
  connected: boolean;
  /** Persisted-state of the buffer, for an explicit save indicator. */
  saveState: SaveState;
  /** Epoch ms when the buffer last became consistent with disk (null until first). */
  lastSavedAt: number | null;
  /** Debounced, version-checked write of the full document to disk. */
  save: (content: string, decisionUpdate?: DecisionQueueUpdate) => void;
  /** Flush any pending save immediately (Cmd/Ctrl+S, blur, page hide). */
  flushNow: () => void;
  /** Report the editor's live caret/selection so agent writes can avoid it. */
  reportSelection: (from: number, to: number) => void;
}

const SAVE_DEBOUNCE_MS = 500;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

function parseJsonOrEmpty(text: string): unknown {
  try {
    return JSON.parse(text) ?? {};
  } catch {
    return {};
  }
}

export function reconnectSnapshotMatchesDocument(
  expectedDocumentPath: string | null,
  snapshotDocumentPath: string,
): boolean {
  return expectedDocumentPath !== null && expectedDocumentPath === snapshotDocumentPath;
}

export function parseDocSnapshot(value: unknown): DocState {
  const state = value as Partial<DocState> | null;
  if (
    !state ||
    typeof state.content !== "string" ||
    typeof state.version !== "number" ||
    typeof state.path !== "string" ||
    typeof state.serverEpoch !== "string"
  ) {
    throw new Error("ACM server returned an incompatible document snapshot");
  }
  return state as DocState;
}

export function reconnectSnapshotNeedsStateRestore(
  snapshotVersion: number,
  currentVersion: number,
): boolean {
  return snapshotVersion === currentVersion;
}

export function reconnectSnapshotStartsNewEpoch(args: {
  currentEpoch: string | null;
  currentVersion: number;
  snapshotEpoch: string;
  snapshotVersion: number;
}): boolean {
  return args.currentEpoch !== null && args.snapshotEpoch !== args.currentEpoch;
}

export function saveResponseMatchesCurrentEpoch(
  requestEpoch: string | null,
  currentEpoch: string | null,
): boolean {
  return requestEpoch !== null && requestEpoch === currentEpoch;
}

export function auditEndpointReadyForEpoch(
  readyEpoch: string | null,
  requestEpoch: string | null,
): boolean {
  return requestEpoch !== null && readyEpoch === requestEpoch;
}

export function decisionEntriesForFlush(
  entries: readonly DecisionOutboxEntry[],
  hasPendingContent: boolean,
  deferredEventIds: ReadonlySet<string> = new Set(),
): DecisionOutboxEntry[] {
  const safeEntries = entries.filter(({ event }) => !deferredEventIds.has(event.id));
  return hasPendingContent
    ? safeEntries
    : safeEntries.filter((entry) => entry.writeState === "committed");
}

export function planServerEpochReconnect(args: {
  pendingContent: string | null;
  lastConfirmedContent: string | null;
  snapshotContent: string;
  unansweredSaves?: readonly string[];
}): { kind: "rebaseline" } | { kind: "flush"; content: string } | { kind: "conflict" } {
  if (args.pendingContent === null) return { kind: "rebaseline" };
  // A save whose reply was lost landed before the restart: the buffer already
  // descends from the snapshot, so there is nothing to merge.
  if (args.unansweredSaves?.includes(args.snapshotContent)) {
    return { kind: "flush", content: args.pendingContent };
  }
  if (args.lastConfirmedContent === null) return { kind: "conflict" };
  const merged = merge3(
    args.pendingContent,
    args.lastConfirmedContent,
    args.snapshotContent,
  );
  return merged.clean ? { kind: "flush", content: merged.result } : { kind: "conflict" };
}

export async function probeDecisionEndpoint(args: {
  snapshotRevision: number;
  currentRevision: () => number;
  snapshotEpoch: string | null;
  currentEpoch: () => string | null;
  probe: () => Promise<boolean>;
}): Promise<"ready" | "unavailable" | "stale" | "epoch-stale"> {
  const endpointAvailable = await args.probe();
  if (!saveResponseMatchesCurrentEpoch(args.snapshotEpoch, args.currentEpoch())) {
    return "epoch-stale";
  }
  if (args.snapshotRevision !== args.currentRevision()) return "stale";
  return endpointAvailable ? "ready" : "unavailable";
}

export async function postDecisionEvents(
  documentPath: string | null,
  events: readonly DecisionEvent[],
  request: typeof fetch = fetch,
): Promise<{ persisted: boolean; recoveryNeedsReview: boolean }> {
  if (!documentPath) return { persisted: false, recoveryNeedsReview: false };
  try {
    const res = await request("/api/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentPath, decisionEvents: events }),
    });
    const data = (await res.json().catch(() => null)) as
      | {
          audit?: {
            status?: unknown;
            decisionEventIds?: unknown;
            recovery?: { status?: unknown };
          };
        }
      | null;
    const persisted =
      res.ok &&
      data?.audit?.status === "persisted" &&
      Array.isArray(data.audit.decisionEventIds) &&
      data.audit.decisionEventIds.length === events.length &&
      data.audit.decisionEventIds.every((id, index) => id === events[index].id);
    return {
      persisted,
      recoveryNeedsReview:
        persisted &&
        (data?.audit?.recovery?.status === "failed" ||
          data?.audit?.recovery?.status === "quarantined"),
    };
  } catch {
    return { persisted: false, recoveryNeedsReview: false };
  }
}

export function decisionEventsForAuditRetry(
  sent: readonly DecisionEvent[],
  committed: unknown,
): DecisionEvent[] {
  if (
    !Array.isArray(committed) ||
    committed.length !== sent.length ||
    !committed.every(isDecisionEvent) ||
    !committed.every((event, index) => event.id === sent[index]?.id)
  ) {
    return [...sent];
  }
  return committed;
}

export type DecisionEndpointRead<T> =
  | { status: "ready"; value: T; needsReview: boolean }
  | { status: "unavailable" }
  | { status: "invalid" };

export interface DecisionBootstrapPlan {
  persistedEventIds: Set<string> | null;
  recoveredEvents: DecisionEvent[] | null;
  retryOnReconnect: boolean;
  needsReview: boolean;
}

export function planDecisionBootstrap(
  history: DecisionEndpointRead<Set<string>>,
  recovery: DecisionEndpointRead<DecisionEvent[]>,
): DecisionBootstrapPlan {
  const complete = history.status === "ready" && recovery.status === "ready";
  return {
    persistedEventIds: complete ? history.value : null,
    recoveredEvents: complete ? recovery.value : null,
    retryOnReconnect: !complete,
    needsReview:
      history.status === "invalid" ||
      recovery.status === "invalid" ||
      (history.status === "ready" && history.needsReview) ||
      (recovery.status === "ready" && recovery.needsReview),
  };
}

export async function fetchPersistedDecisionEventIds(
  request: typeof fetch = fetch,
  timeoutMs = 1_500,
): Promise<DecisionEndpointRead<Set<string>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await request("/api/decisions", { signal: controller.signal });
    if (!res.ok) return { status: "unavailable" };
    let data: { decisionEvents?: unknown; decisionHistoryIssues?: unknown };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      return { status: "invalid" };
    }
    if (!Array.isArray(data.decisionEvents)) return { status: "invalid" };
    if (
      data.decisionHistoryIssues !== undefined &&
      !Array.isArray(data.decisionHistoryIssues)
    ) {
      return { status: "invalid" };
    }
    return {
      status: "ready",
      value: new Set(
        data.decisionEvents
          .map((event) =>
            event &&
            typeof event === "object" &&
            typeof (event as { id?: unknown }).id === "string"
              ? (event as { id: string }).id
              : null,
          )
          .filter((id): id is string => id !== null),
      ),
      needsReview:
        Array.isArray(data.decisionHistoryIssues) && data.decisionHistoryIssues.length > 0,
    };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchDecisionRecoveryEvents(
  request: typeof fetch = fetch,
  timeoutMs = 1_500,
): Promise<DecisionEndpointRead<DecisionEvent[]>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await request("/api/decision-recovery", { signal: controller.signal });
    if (!res.ok) return { status: "unavailable" };
    let data: { decisionEvents?: unknown };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      return { status: "invalid" };
    }
    if (!Array.isArray(data.decisionEvents) || !data.decisionEvents.every(isDecisionEvent)) {
      return { status: "invalid" };
    }
    return { status: "ready", value: data.decisionEvents, needsReview: false };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export function useDocSync(opts: UseDocSyncOptions): UseDocSyncResult {
  const [initialDoc, setInitialDoc] = useState<string | null>(null);
  const [initialVersion, setInitialVersion] = useState(0);
  const [activeDocumentPath, setActiveDocumentPath] = useState<string | null>(null);
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
  const currentServerEpoch = useRef<string | null>(null);
  const lastConfirmedContent = useRef<string | null>(null);
  const documentPath = useRef<string | null>(null);

  // Latest content queued for save, plus the debounce timer.
  const pendingContent = useRef<string | null>(null);
  const pendingDecisionEntries = useRef<DecisionOutboxEntry[]>([]);
  const decisionQueueRevision = useRef(0);
  const deferredDecisionEventIds = useRef<Set<string>>(new Set());
  const decisionRecoveryQuarantined = useRef(false);
  const decisionBootstrapRetryNeeded = useRef(false);
  const decisionOutboxStorageFailed = useRef(false);
  const auditEndpointEpoch = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One save at a time (#128). A second PUT sent before the first answers carries
  // the same baseVersion, so the server sees two versions of the line being typed,
  // both descended from that base, and its keep-both merge writes the line twice.
  const flushRunning = useRef(false);
  const flushRequested = useRef(false);
  const contentOnTheWire = useRef<string | null>(null);
  // Saves that got no answer but may still have landed. The next PUT names them so
  // the server merges from the newest that did, whatever else has changed since.
  const unansweredSaves = useRef<Array<{ id: string; content: string }>>([]);
  // The newest push adoptRemote could not apply because a save was on the wire.
  // A save that then settles with nothing typed since leaves the editor on an
  // older version than the one this push already delivered.
  const droppedPush = useRef<{ content: string; version: number } | null>(null);

  // Presence: a throttled caret push so agent writes can steer clear of where the
  // human is editing. Advisory only — the server-side merge is the real guarantee.
  const presenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSel = useRef<{ from: number; to: number } | null>(null);

  // WebSocket + reconnect machinery.
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(RECONNECT_MIN_MS);
  const mounted = useRef(true);

  // Keep the latest callback in a ref so the socket lifecycle effect runs once.
  const onRemoteUpdate = useRef(opts.onRemoteUpdate);
  onRemoteUpdate.current = opts.onRemoteUpdate;
  const author = useRef(opts.author);
  author.current = opts.author;

  const settledSaveState = (): SaveState => {
    if (decisionRecoveryQuarantined.current) return "audit-recovery";
    if (decisionBootstrapRetryNeeded.current) return "audit-error";
    if (deferredDecisionEventIds.current.size > 0) return "audit-recovery";
    if (decisionOutboxStorageFailed.current) return "audit-error";
    return pendingDecisionEntries.current.length > 0 ? "audit-error" : "saved";
  };
  const hasCommittedDecisionRetry = () =>
    decisionEntriesForFlush(
      pendingDecisionEntries.current,
      false,
      deferredDecisionEventIds.current,
    ).length > 0;

  const adoptRemote = useCallback((content: string, version: number) => {
    // Only adopt strictly-NEWER server states. A reconnect-resync GET can resolve
    // after a newer WS push (or arrive stale/equal); applying it would regress the
    // editor. Guard before any side effect.
    if (version <= currentVersion.current) return;

    // Self-echo: the server now broadcasts EVERY write, including our own PUT. If the
    // incoming content is exactly our pending buffer, our write just landed — adopt the
    // version and mark saved instead of flashing a spurious conflict + redundant flush.
    if (content === pendingContent.current) {
      currentVersion.current = version;
      lastConfirmedContent.current = content;
      unansweredSaves.current = []; // the buffer now descends from this state
      pendingContent.current = null;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      setSaveState(hasCommittedDecisionRetry() ? "saving" : settledSaveState());
      setLastSavedAt(Date.now());
      return;
    }

    // The echo of our own save, racing its HTTP response, while the user typed on.
    // Nothing changed underneath us: the response advances the version and the
    // newer keystrokes go out in the save after it.
    if (content === contentOnTheWire.current) return;

    // DATA-INTEGRITY RULE: never rebase over UNSAVED local edits. If the buffer has
    // pending changes the user hasn't seen persisted, adopting remote content here
    // would silently discard their work (the old behaviour — a real source of lost
    // edits). Instead, KEEP the local buffer, flag a conflict, and FLUSH NOW (#19)
    // rather than waiting out the debounce — the PUT 409s, adopts the new version,
    // and re-persists the user's text immediately, shrinking the window in which a
    // second remote write could interleave. User wins either way; the 'conflict'
    // status is the visible signal.
    if (pendingContent.current !== null) {
      if (flushRunning.current) droppedPush.current = { content, version };
      setSaveState("conflict");
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      void flushRef.current();
      return;
    }
    currentVersion.current = version;
    lastConfirmedContent.current = content;
    onRemoteUpdate.current(content, version);
    setSaveState(settledSaveState());
    setLastSavedAt(Date.now());
  }, []);

  // ── Mount: initial snapshot + WebSocket with reconnect ──────────────────────
  useEffect(() => {
    mounted.current = true;

    const fetchSnapshot = async () => {
      const res = await fetch("/api/doc");
      const { content, version, path, serverEpoch } = parseDocSnapshot(await res.json());
      // NB: do NOT mutate currentVersion here — adoptRemote is the single,
      // monotonic writer (except the initial baseline below). A bare set here
      // would let a late stale GET regress the baseline past adoptRemote's guard.
      return { content, version, path, serverEpoch };
    };

    const retryDecisionBootstrap = async (path: string): Promise<boolean> => {
      if (!decisionBootstrapRetryNeeded.current) return true;
      const serverEpoch = currentServerEpoch.current;
      const [historyRead, recoveryRead] = await Promise.all([
        fetchPersistedDecisionEventIds(),
        fetchDecisionRecoveryEvents(),
      ]);
      if (
        !mounted.current ||
        documentPath.current !== path ||
        currentServerEpoch.current !== serverEpoch
      ) {
        return false;
      }

      const bootstrap = planDecisionBootstrap(historyRead, recoveryRead);
      decisionBootstrapRetryNeeded.current = bootstrap.retryOnReconnect;
      decisionRecoveryQuarantined.current ||= bootstrap.needsReview;
      if (bootstrap.persistedEventIds === null || bootstrap.recoveredEvents === null) {
        setSaveState(settledSaveState());
        return true;
      }

      const reconciled = reconcileDeferredDecisionOutbox(
        path,
        pendingDecisionEntries.current,
        deferredDecisionEventIds.current,
        bootstrap.persistedEventIds,
        bootstrap.recoveredEvents,
      );
      pendingDecisionEntries.current = reconciled.entries;
      deferredDecisionEventIds.current = new Set();
      decisionQueueRevision.current += 1;
      decisionRecoveryQuarantined.current ||= reconciled.recoveryQuarantined;
      decisionOutboxStorageFailed.current ||= reconciled.storageFailed;
      setSaveState(settledSaveState());
      return true;
    };

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${scheme}://${location.host}/ws`);
      wsRef.current = ws;
      let documentVerified = false;
      let closed = false;
      let queuedMessage: Extract<ServerMessage, { type: "update" }> | null = null;

      const retryConnection = (state: SaveState) => {
        if (!mounted.current || closed) return;
        closed = true;
        ws.onclose = null;
        ws.onmessage = null;
        ws.close();
        connectedRef.current = false;
        setConnected(false);
        setSaveState(state);
        reconnectTimer.current = setTimeout(connect, reconnectDelay.current);
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, RECONNECT_MAX_MS);
      };

      ws.onopen = () => {
        void fetchSnapshot()
          .then(async ({ content, version, path, serverEpoch }) => {
            if (!mounted.current || closed) return;
            if (!reconnectSnapshotMatchesDocument(documentPath.current, path)) {
              retryConnection("conflict");
              return;
            }
            // Awaited while still offline, before anything below reads the buffer: a
            // save made meanwhile is held, and the plan sees it instead of replacing it.
            if (!(await retryDecisionBootstrap(path))) return;
            if (!mounted.current || closed) return;
            if (queuedMessage && queuedMessage.serverEpoch !== serverEpoch) {
              retryConnection("conflict");
              return;
            }
            // A push may land while the reconnect GET is in flight. Rebase/adopt
            // against the newest state from this exact server epoch rather than
            // flushing onto a snapshot the socket has already superseded.
            const reconnectContent =
              queuedMessage && queuedMessage.version > version
                ? queuedMessage.content
                : content;
            const reconnectVersion =
              queuedMessage && queuedMessage.version > version
                ? queuedMessage.version
                : version;
            queuedMessage = null;
            const startsNewEpoch = reconnectSnapshotStartsNewEpoch({
              currentEpoch: currentServerEpoch.current,
              currentVersion: currentVersion.current,
              snapshotEpoch: serverEpoch,
              snapshotVersion: reconnectVersion,
            });
            documentVerified = true;
            connectedRef.current = true; // sync — reconnect flush below must see us online
            setConnected(true);
            reconnectDelay.current = RECONNECT_MIN_MS;
            if (startsNewEpoch) {
              const epochPlan = planServerEpochReconnect({
                pendingContent: pendingContent.current,
                lastConfirmedContent: lastConfirmedContent.current,
                snapshotContent: reconnectContent,
                unansweredSaves: unansweredSaves.current.map((save) => save.content),
              });
              if (epochPlan.kind === "conflict") {
                retryConnection("conflict");
                return;
              }
              currentServerEpoch.current = serverEpoch;
              currentVersion.current = reconnectVersion;
              lastConfirmedContent.current = reconnectContent;
              droppedPush.current = null; // from the previous server lifetime
              unansweredSaves.current = [];
              if (epochPlan.kind === "flush") {
                pendingContent.current = epochPlan.content;
                onRemoteUpdate.current(epochPlan.content, reconnectVersion);
                flushRef.current();
              } else {
                onRemoteUpdate.current(reconnectContent, reconnectVersion);
                if (hasCommittedDecisionRetry()) flushRef.current();
                else {
                  setSaveState(settledSaveState());
                  setLastSavedAt(Date.now());
                }
              }
              return;
            }
            if (pendingContent.current !== null || hasCommittedDecisionRetry()) {
              // Edits or audit events made while offline: persist them only after the
              // reconnecting server proves it still owns the same document.
              flushRef.current();
            } else {
              const restoreSettledState = reconnectSnapshotNeedsStateRestore(
                reconnectVersion,
                currentVersion.current,
              );
              adoptRemote(reconnectContent, reconnectVersion);
              // adoptRemote deliberately ignores equal/older snapshots. A successful
              // same-document reconnect still needs to clear the temporary badge that
              // the failed verification attempt set.
              if (restoreSettledState) setSaveState(settledSaveState());
            }
          })
          .catch(() => retryConnection("offline"));
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        if (msg.type !== "update") return;
        if (!documentVerified) queuedMessage = msg;
        else if (msg.serverEpoch !== currentServerEpoch.current) {
          retryConnection("conflict");
        } else adoptRemote(msg.content, msg.version);
      };

      ws.onclose = () => {
        if (!mounted.current || closed) return;
        closed = true;
        connectedRef.current = false;
        setConnected(false);
        if (pendingContent.current !== null || hasCommittedDecisionRetry()) {
          setSaveState("offline"); // edits and audit events held until reconnect
        }
        reconnectTimer.current = setTimeout(connect, reconnectDelay.current);
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, RECONNECT_MAX_MS);
      };
    };

    // Identify the exact document before opening the socket or replaying an audit
    // outbox. Reused localhost ports must never inherit another document's events.
    const loadInitial = () => {
      fetchSnapshot()
        .then(async ({ content, version, path, serverEpoch }) => {
          const [historyRead, recoveryRead] = await Promise.all([
            fetchPersistedDecisionEventIds(),
            fetchDecisionRecoveryEvents(),
          ]);
          if (!mounted.current) return;
          const bootstrap = planDecisionBootstrap(historyRead, recoveryRead);
          documentPath.current = path;
          const outbox = loadDecisionOutboxState(
            path,
            undefined,
            bootstrap.persistedEventIds,
          );
          pendingDecisionEntries.current =
            bootstrap.recoveredEvents === null
              ? outbox.entries
              : mergeCommittedDecisionOutbox(outbox.entries, bootstrap.recoveredEvents);
          deferredDecisionEventIds.current = outbox.verificationDeferred
            ? new Set(
                pendingDecisionEntries.current
                  .filter((entry) => entry.writeState === "pending")
                  .map(({ event }) => event.id),
              )
            : new Set();
          decisionQueueRevision.current =
            pendingDecisionEntries.current.length > 0 ? 1 : 0;
          decisionBootstrapRetryNeeded.current = bootstrap.retryOnReconnect;
          decisionRecoveryQuarantined.current =
            outbox.legacyQuarantined ||
            outbox.recoveryQuarantined ||
            bootstrap.needsReview;
          const recoveredStored =
            bootstrap.recoveredEvents === null || bootstrap.recoveredEvents.length === 0
              ? true
              : storeDecisionOutbox(path, pendingDecisionEntries.current);
          decisionOutboxStorageFailed.current = outbox.storageFailed || !recoveredStored;
          currentServerEpoch.current = serverEpoch;
          currentVersion.current = version;
          lastConfirmedContent.current = content;
          setActiveDocumentPath(path);
          setInitialDoc(content);
          setInitialVersion(version);
          setSaveState(settledSaveState());
          connect();
        })
        .catch(() => {
          if (!mounted.current) return;
          reconnectTimer.current = setTimeout(loadInitial, reconnectDelay.current);
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, RECONNECT_MAX_MS);
        });
    };
    loadInitial();

    return () => {
      mounted.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (presenceTimer.current) clearTimeout(presenceTimer.current);
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
  const sendSave = useCallback(async () => {
    const sent = pendingContent.current;
    const sentDecisionEntries = decisionEntriesForFlush(
      pendingDecisionEntries.current,
      sent !== null,
      deferredDecisionEventIds.current,
    );
    const sentDecisionEvents = decisionOutboxEvents(sentDecisionEntries);
    const sentDecisionRevision = decisionQueueRevision.current;
    const requestEpoch = currentServerEpoch.current;
    if (sent === null && sentDecisionEvents.length === 0) {
      setSaveState(settledSaveState());
      return;
    }
    if (!connectedRef.current) {
      setSaveState("offline"); // held; flushed on reconnect (onopen below)
      return;
    }
    setSaveState("saving");

    // The document write landed but its audit did not: reconcile the document as
    // usual and keep these events queued as committed, for an audit-only retry.
    let auditRetryOwed = false;
    const confirmDecisionEvents = () => {
      if (auditRetryOwed || sentDecisionEvents.length === 0) return;
      pendingDecisionEntries.current = removeDecisionOutboxEvents(
        pendingDecisionEntries.current,
        sentDecisionEvents,
      );
      decisionQueueRevision.current += 1;
      if (documentPath.current) {
        const stored = storeDecisionOutbox(
          documentPath.current,
          pendingDecisionEntries.current,
        );
        decisionOutboxStorageFailed.current = !stored;
        if (!stored) {
          setSaveState("audit-error");
        }
      }
    };

    const markSentDecisionEventsCommitted = () => {
      if (sentDecisionEvents.length === 0) return;
      pendingDecisionEntries.current = markDecisionOutboxCommitted(
        pendingDecisionEntries.current,
        sentDecisionEvents,
      );
      decisionQueueRevision.current += 1;
      if (
        documentPath.current
      ) {
        const stored = storeDecisionOutbox(
          documentPath.current,
          pendingDecisionEntries.current,
        );
        decisionOutboxStorageFailed.current = !stored;
        if (!stored) setSaveState("audit-error");
      }
    };

    if (sent === null) {
      const auditRequestEpoch = currentServerEpoch.current;
      const auditResult = await postDecisionEvents(
        documentPath.current,
        sentDecisionEvents,
      );
      if (auditResult.recoveryNeedsReview) decisionRecoveryQuarantined.current = true;
      if (auditResult.persisted) {
        confirmDecisionEvents();
        if (saveResponseMatchesCurrentEpoch(auditRequestEpoch, currentServerEpoch.current)) {
          auditEndpointEpoch.current = auditRequestEpoch;
          setSaveState(settledSaveState());
          setLastSavedAt(Date.now());
        }
      } else if (
        saveResponseMatchesCurrentEpoch(auditRequestEpoch, currentServerEpoch.current)
      ) {
        setSaveState("audit-error");
      }
      return;
    }

    // A zero-event POST is a mutation-free capability probe. A stale static app
    // therefore cannot apply a decision through an older server and discover only
    // afterwards that no durable audit path exists.
    if (
      sentDecisionEvents.length > 0 &&
      !auditEndpointReadyForEpoch(auditEndpointEpoch.current, requestEpoch)
    ) {
      const probeResult = await probeDecisionEndpoint({
        snapshotRevision: sentDecisionRevision,
        currentRevision: () => decisionQueueRevision.current,
        snapshotEpoch: requestEpoch,
        currentEpoch: () => currentServerEpoch.current,
        probe: async () =>
          (await postDecisionEvents(documentPath.current, [])).persisted,
      });
      if (probeResult === "epoch-stale") return;
      if (probeResult === "stale") {
        // An undo/redo changed the queued decision while the capability probe was
        // in flight. The save() call that changed it already scheduled a fresh flush;
        // never persist the stale event or the stale pre-undo document snapshot.
        setSaveState(connectedRef.current ? "unsaved" : "offline");
        return;
      }
      if (probeResult === "unavailable") {
        setSaveState("audit-error");
        return;
      }
      auditEndpointEpoch.current = requestEpoch;
    }

    if (!saveResponseMatchesCurrentEpoch(requestEpoch, currentServerEpoch.current)) {
      return;
    }

    const baseVersion = currentVersion.current; // the version this buffer descends from
    contentOnTheWire.current = sent;
    const saveId = globalThis.crypto.randomUUID();
    const noteUnanswered = () => {
      // Its echo or a newer push was adopted first, so the buffer has moved past it.
      if (currentVersion.current !== baseVersion) return;
      unansweredSaves.current = [...unansweredSaves.current, { id: saveId, content: sent }].slice(-KEEP_VERSIONS);
    };
    let res: Response;
    let responseText: string;
    try {
      res = await fetch("/api/doc", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: sent,
          baseVersion,
          serverEpoch: requestEpoch,
          documentPath: documentPath.current,
          author: author.current,
          decisionEvents: sentDecisionEvents,
          saveId,
          unansweredSaveIds: unansweredSaves.current.map((save) => save.id),
        }),
      });
      responseText = await res.text(); // a dropped connection can fail here too
    } catch {
      if (!saveResponseMatchesCurrentEpoch(requestEpoch, currentServerEpoch.current)) {
        return;
      }
      noteUnanswered();
      connectedRef.current = false;
      setConnected(false);
      setSaveState("offline"); // network blip — keep pending, retry on reconnect
      wsRef.current?.close();
      return;
    }

    const data = parseJsonOrEmpty(responseText) as {
      version?: number;
      content?: string;
      conflict?: string;
      audit?: {
        status?: string;
        code?: string;
        retryable?: boolean;
        decisionEvents?: DecisionEvent[];
        decisionEventIds?: string[];
        recovery?: { status?: string };
      };
    };
    const reflush = () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flushRef.current(), SAVE_DEBOUNCE_MS);
    };
    const confirmServerState = (version: number, content: string) => {
      currentVersion.current = version;
      lastConfirmedContent.current = content;
    };
    if (!saveResponseMatchesCurrentEpoch(requestEpoch, currentServerEpoch.current)) {
      // A response from a previous server lifetime cannot advance the new epoch's
      // version, clear its pending content, or overwrite its reconnect state.
      return;
    }
    if (res.status === 409 && data.conflict === "server-epoch") {
      // The HTTP request reached a different server lifetime than the socket was
      // verified against. Keep the pending buffer and force the normal reconnect
      // path to fetch that epoch's snapshot and three-way rebase before retrying.
      connectedRef.current = false;
      setConnected(false);
      setSaveState("conflict");
      wsRef.current?.close();
      return;
    }
    let reconcileStatus = res.status;
    if (
      data.audit?.status === "persisted" &&
      (data.audit.recovery?.status === "failed" ||
        data.audit.recovery?.status === "quarantined")
    ) {
      decisionRecoveryQuarantined.current = true;
    }
    const auditFailed =
      res.status === 500 &&
      data.audit?.status === "failed" &&
      data.audit.code === "decision-persistence";
    const auditMissing =
      res.ok &&
      sentDecisionEvents.length > 0 &&
      !decisionEventsAcknowledged(sentDecisionEvents, data.audit);
    if (auditFailed || auditMissing) {
      // The server response proves the Markdown commit landed. Preserve that
      // evidence before the audit-only retry so a crash can never turn this
      // into an ambiguous pre-commit event or a ghost replay.
      markSentDecisionEventsCommitted();
      const retryDecisionEvents = decisionEventsForAuditRetry(
        sentDecisionEvents,
        data.audit?.decisionEvents,
      );
      const auditRequestEpoch = currentServerEpoch.current;
      const auditResult = await postDecisionEvents(
        documentPath.current,
        retryDecisionEvents,
      );
      if (auditResult.recoveryNeedsReview) decisionRecoveryQuarantined.current = true;
      if (auditResult.persisted) {
        confirmDecisionEvents();
        if (
          saveResponseMatchesCurrentEpoch(auditRequestEpoch, currentServerEpoch.current)
        ) {
          auditEndpointEpoch.current = auditRequestEpoch;
        }
      }
      if (!saveResponseMatchesCurrentEpoch(requestEpoch, currentServerEpoch.current)) {
        return;
      }
      if (!auditResult.persisted) {
        setSaveState("audit-error");
        if (typeof data.version !== "number") return;
        setLastSavedAt(Date.now());
        auditRetryOwed = true;
      }
      if (auditFailed) reconcileStatus = 200;
    }

    // The pure reconcile decides what's safe. CRITICAL: on a conflict we do NOT touch
    // currentVersion — it stays `baseVersion`, the version this buffer truly descends
    // from, so the next save re-merges server-side instead of fast-path-overwriting
    // content the buffer never incorporated (the data-loss path two reviews found).
    const d = reconcileSave({
      status: reconcileStatus,
      version: data.version,
      serverContent: data.content,
      sent,
      buffer: pendingContent.current,
      conflict: data.conflict,
      base: lastConfirmedContent.current,
    });
    if (d.kind === "failed") noteUnanswered();
    else if (d.kind !== "conflict") unansweredSaves.current = [];
    if (d.kind !== "failed" && d.kind !== "conflict" && d.version < currentVersion.current) {
      // A newer push or snapshot was adopted while this reply travelled: the write it
      // reports stands for the audit trail, but its document state is out of date.
      if (d.kind !== "stale") confirmDecisionEvents();
      if (pendingContent.current !== null) reflush();
      else {
        setSaveState(settledSaveState());
        setLastSavedAt(Date.now());
      }
      return;
    }
    switch (d.kind) {
      case "failed":
        setSaveState(connectedRef.current ? "unsaved" : "offline"); // keep pending; retry on next edit/reconnect
        return;
      case "conflict":
        setSaveState("conflict"); // buffer kept; currentVersion deliberately unchanged
        return;
      case "stale":
        confirmServerState(d.version, data.content ?? sent);
        onRemoteUpdate.current(d.pending, d.version);
        pendingContent.current = d.pending;
        reflush();
        return;
      case "saved": {
        confirmDecisionEvents();
        confirmServerState(d.version, data.content ?? sent);
        if (d.adopt !== undefined) onRemoteUpdate.current(d.adopt, d.version);
        pendingContent.current = null; // confirmed written
        setSaveState(settledSaveState());
        setLastSavedAt(Date.now());
        const dropped = droppedPush.current;
        droppedPush.current = null;
        if (dropped) adoptRemote(dropped.content, dropped.version);
        return;
      }
      case "reflush":
        confirmDecisionEvents();
        confirmServerState(d.version, data.content ?? sent);
        reflush(); // server stored exactly what we sent; persist the newer keystrokes
        return;
      case "rebased":
        confirmDecisionEvents();
        confirmServerState(d.version, data.content ?? sent);
        onRemoteUpdate.current(d.pending, d.version); // editor now shows keystrokes + the merged-in card
        pendingContent.current = d.pending;
        reflush(); // persist the rebased buffer
        return;
    }
  }, [adoptRemote]);

  const flush = useCallback(async () => {
    if (flushRunning.current) {
      flushRequested.current = true; // sent once the save on the wire has answered
      return;
    }
    flushRunning.current = true;
    try {
      await sendSave();
    } finally {
      flushRunning.current = false;
      contentOnTheWire.current = null;
      if (flushRequested.current) {
        flushRequested.current = false;
        void flushRef.current();
      }
    }
  }, [sendSave]);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const save = useCallback((
    content: string,
    decisionUpdate: DecisionQueueUpdate = { enqueue: [], cancel: [] },
  ) => {
    // Coalesce rapid calls: always send the latest content on the next fire.
    const previousContent = pendingContent.current ?? lastConfirmedContent.current;
    let decisionQueueChanged = false;
    if (previousContent !== null && previousContent !== content) {
      const rebased = rebasePendingDecisionOutbox(
        pendingDecisionEntries.current,
        previousContent,
        content,
      );
      if (rebased !== pendingDecisionEntries.current) {
        pendingDecisionEntries.current = rebased;
        decisionQueueChanged = true;
      }
    }
    pendingContent.current = content;
    let outboxStored = true;
    if (decisionUpdate.enqueue.length > 0 || decisionUpdate.cancel.length > 0) {
      decisionQueueChanged = true;
    }
    if (decisionUpdate.cancel.length > 0) {
      pendingDecisionEntries.current = removeDecisionOutboxEvents(
        pendingDecisionEntries.current,
        decisionUpdate.cancel,
      );
    }
    if (decisionUpdate.enqueue.length > 0) {
      pendingDecisionEntries.current = mergeDecisionOutbox(
        pendingDecisionEntries.current,
        decisionUpdate.enqueue,
      );
    }
    if (decisionQueueChanged) decisionQueueRevision.current += 1;
    if (
      documentPath.current &&
      decisionQueueChanged
    ) {
      const stored = storeDecisionOutbox(
        documentPath.current,
        pendingDecisionEntries.current,
      );
      decisionOutboxStorageFailed.current = !stored;
      if (!stored) {
        outboxStored = false;
      }
    }
    setSaveState(
      outboxStored ? (connectedRef.current ? "unsaved" : "offline") : "audit-error",
    );
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

  // Report the caret/selection to the server, throttled to one PUT per ~300ms (the
  // latest position wins). Powers the agent-avoids-cursor guard; failures are silent.
  const reportSelection = useCallback((from: number, to: number) => {
    pendingSel.current = { from, to };
    if (presenceTimer.current) return; // a push is already scheduled
    presenceTimer.current = setTimeout(() => {
      presenceTimer.current = null;
      const sel = pendingSel.current;
      if (!sel || !connectedRef.current) return;
      void fetch("/api/presence", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sel),
      }).catch(() => {});
    }, 300);
  }, []);

  // Persist pending edits when the tab loses focus / is hidden / is closing, so a
  // mid-debounce edit can't be stranded if the window goes away.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    const onUnload = (event: BeforeUnloadEvent) => {
      flushNow();
      if (unloadWouldLoseEdits(pendingContent.current)) {
        event.preventDefault(); // the browser's "Leave site?" prompt
        event.returnValue = "";
      }
    };
    window.addEventListener("blur", flushNow);
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("blur", flushNow);
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [flushNow]);

  return {
    initialDoc,
    initialVersion,
    documentPath: activeDocumentPath,
    connected,
    saveState,
    lastSavedAt,
    save,
    flushNow,
    reportSelection,
  };
}
