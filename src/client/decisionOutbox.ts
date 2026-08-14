import {
  isDecisionEvent,
  rebaseDecisionEventsAfterChange,
  type DecisionEvent,
} from "../lib/decision";

const DECISION_OUTBOX_PREFIX = "acm-decision-outbox:";
const DECISION_OUTBOX_VERSION = 2;
export const LEGACY_DECISION_OUTBOX_KEY = "acm-decision-outbox";
const LEGACY_DECISION_OUTBOX_QUARANTINE_KEY = `${DECISION_OUTBOX_PREFIX}legacy-quarantine`;

export function decisionOutboxKey(documentPath: string): string {
  return `${DECISION_OUTBOX_PREFIX}${encodeURIComponent(documentPath)}`;
}

export function decisionOutboxQuarantineKey(documentPath: string): string {
  return `${decisionOutboxKey(documentPath)}:quarantine`;
}

export function legacyDecisionOutboxQuarantineKey(): string {
  return LEGACY_DECISION_OUTBOX_QUARANTINE_KEY;
}

export interface DecisionOutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DecisionOutboxEntry {
  event: DecisionEvent;
  /** Pending events have no positive evidence that their Markdown write landed.
   * Only committed events may be retried automatically after a cold start. */
  writeState: "pending" | "committed";
}

interface PersistedDecisionOutbox {
  version: typeof DECISION_OUTBOX_VERSION;
  entries: DecisionOutboxEntry[];
}

export interface DecisionOutboxState {
  entries: DecisionOutboxEntry[];
  /** Events safe to retry now (all have positive document-commit evidence). */
  events: DecisionEvent[];
  /** An older unscoped queue was preserved but cannot safely be assigned. */
  legacyQuarantined: boolean;
  /** At least one ambiguous or malformed per-document entry was preserved. */
  recoveryQuarantined: boolean;
  /** Browser storage failed while loading or preserving recovery evidence. */
  storageFailed: boolean;
  /** Durable history was unavailable, so pending entries remain untouched. */
  verificationDeferred: boolean;
}

function browserStorage(): DecisionOutboxStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isDecisionOutboxEntry(value: unknown): value is DecisionOutboxEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DecisionOutboxEntry>;
  return (
    (entry.writeState === "pending" || entry.writeState === "committed") &&
    isDecisionEvent(entry.event)
  );
}

function parsePersistedOutbox(raw: string): PersistedDecisionOutbox | null {
  try {
    const value = JSON.parse(raw) as Partial<PersistedDecisionOutbox> | null;
    if (
      !value ||
      value.version !== DECISION_OUTBOX_VERSION ||
      !Array.isArray(value.entries) ||
      !value.entries.every(isDecisionOutboxEntry)
    ) {
      return null;
    }
    return value as PersistedDecisionOutbox;
  } catch {
    return null;
  }
}

function appendQuarantine(
  storage: DecisionOutboxStorage,
  key: string,
  reason: string,
  raw: string,
): boolean {
  try {
    const record = JSON.stringify({ reason, raw });
    const existing = storage.getItem(key);
    if (!existing?.split("\n").includes(record)) {
      storage.setItem(key, existing ? `${existing}\n${record}` : record);
    }
    return true;
  } catch {
    return false;
  }
}

function removeStored(storage: DecisionOutboxStorage, key: string): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Load only events that can be retried without inventing a decision. Pending
 * entries from an interrupted pre-commit save are preserved for inspection but
 * never posted automatically. Already-persisted ids are simply cleared. */
export function loadDecisionOutboxState(
  documentPath: string,
  storage: DecisionOutboxStorage | null = browserStorage(),
  persistedEventIds: ReadonlySet<string> | null = new Set(),
): DecisionOutboxState {
  if (!storage) {
    return {
      entries: [],
      events: [],
      legacyQuarantined: false,
      recoveryQuarantined: false,
      storageFailed: false,
      verificationDeferred: false,
    };
  }

  let storageFailed = false;
  let legacyQuarantined = false;
  let recoveryQuarantined = false;
  try {
    const legacy = storage.getItem(LEGACY_DECISION_OUTBOX_KEY);
    legacyQuarantined = storage.getItem(LEGACY_DECISION_OUTBOX_QUARANTINE_KEY) !== null;
    if (legacy !== null) {
      const preserved = appendQuarantine(
        storage,
        LEGACY_DECISION_OUTBOX_QUARANTINE_KEY,
        "legacy-unscoped",
        legacy,
      );
      const removed = removeStored(storage, LEGACY_DECISION_OUTBOX_KEY);
      storageFailed ||= !preserved || !removed;
      legacyQuarantined = true;
    }

    const key = decisionOutboxKey(documentPath);
    const quarantineKey = decisionOutboxQuarantineKey(documentPath);
    recoveryQuarantined = storage.getItem(quarantineKey) !== null;
    const raw = storage.getItem(key);
    if (raw === null) {
      return {
        entries: [],
        events: [],
        legacyQuarantined,
        recoveryQuarantined,
        storageFailed,
        verificationDeferred: false,
      };
    }

    const parsed = parsePersistedOutbox(raw);
    if (!parsed) {
      const reason = (() => {
        try {
          return Array.isArray(JSON.parse(raw)) ? "legacy-per-document" : "malformed";
        } catch {
          return "malformed";
        }
      })();
      storageFailed ||= !appendQuarantine(storage, quarantineKey, reason, raw);
      storageFailed ||= !removeStored(storage, key);
      return {
        entries: [],
        events: [],
        legacyQuarantined,
        recoveryQuarantined: true,
        storageFailed,
        verificationDeferred: false,
      };
    }

    if (persistedEventIds === null) {
      const committed = parsed.entries.filter(
        (entry) => entry.writeState === "committed",
      );
      return {
        // Keep unverified pending entries in memory and in every subsequent
        // storage write, but expose only committed events as safe to retry.
        entries: parsed.entries,
        events: committed.map(({ event }) => event),
        legacyQuarantined,
        recoveryQuarantined,
        storageFailed,
        verificationDeferred: parsed.entries.some(
          (entry) => entry.writeState === "pending",
        ),
      };
    }

    const unknown = parsed.entries.filter(
      ({ event }) => !persistedEventIds.has(event.id),
    );
    const pending = unknown.filter((entry) => entry.writeState === "pending");
    const committed = unknown.filter((entry) => entry.writeState === "committed");
    if (pending.length > 0) {
      storageFailed ||= !appendQuarantine(
        storage,
        quarantineKey,
        "document-commit-unconfirmed",
        JSON.stringify({ version: DECISION_OUTBOX_VERSION, entries: pending }),
      );
      recoveryQuarantined = true;
    }
    storageFailed ||= !storeDecisionOutbox(documentPath, committed, storage);
    return {
      entries: committed,
      events: committed.map(({ event }) => event),
      legacyQuarantined,
      recoveryQuarantined,
      storageFailed,
      verificationDeferred: false,
    };
  } catch {
    return {
      entries: [],
      events: [],
      legacyQuarantined,
      recoveryQuarantined,
      storageFailed: true,
      verificationDeferred: false,
    };
  }
}

export function loadDecisionOutbox(
  documentPath: string,
  storage: DecisionOutboxStorage | null = browserStorage(),
  persistedEventIds: ReadonlySet<string> | null = new Set(),
): DecisionEvent[] {
  return loadDecisionOutboxState(documentPath, storage, persistedEventIds).events;
}

export function storeDecisionOutbox(
  documentPath: string,
  entries: readonly DecisionOutboxEntry[],
  storage: DecisionOutboxStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    const key = decisionOutboxKey(documentPath);
    if (entries.length === 0) storage.removeItem(key);
    else {
      const value: PersistedDecisionOutbox = {
        version: DECISION_OUTBOX_VERSION,
        entries: [...entries],
      };
      storage.setItem(key, JSON.stringify(value));
    }
    return true;
  } catch {
    return false;
  }
}

export function decisionOutboxEvents(
  entries: readonly DecisionOutboxEntry[],
): DecisionEvent[] {
  return entries.map(({ event }) => event);
}

export function mergeDecisionOutbox(
  current: readonly DecisionOutboxEntry[],
  incoming: readonly DecisionEvent[],
): DecisionOutboxEntry[] {
  const merged = [...current];
  const known = new Set(current.map(({ event }) => event.id));
  for (const event of incoming) {
    if (known.has(event.id)) continue;
    known.add(event.id);
    merged.push({ event, writeState: "pending" });
  }
  return merged;
}

/** Keep queued result ranges aligned with the latest debounced editor buffer. */
export function rebasePendingDecisionOutbox(
  current: readonly DecisionOutboxEntry[],
  before: string,
  after: string,
): DecisionOutboxEntry[] {
  if (before === after) return current as DecisionOutboxEntry[];
  let changed = false;
  const rebased = current.map((entry) => {
    if (entry.writeState === "committed") return entry;
    const [event] = rebaseDecisionEventsAfterChange([entry.event], before, after);
    if (event === entry.event) return entry;
    changed = true;
    return { ...entry, event };
  });
  return changed ? rebased : current as DecisionOutboxEntry[];
}

/** Server recovery is positive evidence that the Markdown mutation committed.
 * Upgrade a matching browser entry and append any server-only events as safe,
 * audit-only retries. */
export function mergeCommittedDecisionOutbox(
  current: readonly DecisionOutboxEntry[],
  recovered: readonly DecisionEvent[],
): DecisionOutboxEntry[] {
  const recoveredById = new Map(recovered.map((event) => [event.id, event]));
  const merged = current.map((entry) => {
    const event = recoveredById.get(entry.event.id);
    if (!event) return entry;
    recoveredById.delete(entry.event.id);
    return { event, writeState: "committed" as const };
  });
  for (const event of recoveredById.values()) {
    merged.push({ event, writeState: "committed" });
  }
  return merged;
}

export function reconcileDeferredDecisionOutbox(
  documentPath: string,
  current: readonly DecisionOutboxEntry[],
  deferredEventIds: ReadonlySet<string>,
  persistedEventIds: ReadonlySet<string>,
  recoveredEvents: readonly DecisionEvent[],
  storage: DecisionOutboxStorage | null = browserStorage(),
): {
  entries: DecisionOutboxEntry[];
  recoveryQuarantined: boolean;
  storageFailed: boolean;
} {
  const recoveredById = new Map(recoveredEvents.map((event) => [event.id, event]));
  const entries: DecisionOutboxEntry[] = [];
  const known = new Set<string>();
  const ambiguous: DecisionOutboxEntry[] = [];

  for (const entry of current) {
    const id = entry.event.id;
    if (!deferredEventIds.has(id)) {
      entries.push(entry);
      known.add(id);
      continue;
    }
    if (persistedEventIds.has(id)) continue;
    const recovered = recoveredById.get(id);
    if (recovered) {
      entries.push({ event: recovered, writeState: "committed" });
      known.add(id);
      recoveredById.delete(id);
    } else if (entry.writeState === "committed") {
      entries.push(entry);
      known.add(id);
    } else {
      ambiguous.push(entry);
    }
  }

  for (const event of recoveredById.values()) {
    if (persistedEventIds.has(event.id) || known.has(event.id)) continue;
    entries.push({ event, writeState: "committed" });
    known.add(event.id);
  }

  let storageFailed = false;
  if (ambiguous.length > 0) {
    storageFailed =
      !storage ||
      !appendQuarantine(
        storage,
        decisionOutboxQuarantineKey(documentPath),
        "document-commit-unconfirmed",
        JSON.stringify({ version: DECISION_OUTBOX_VERSION, entries: ambiguous }),
      );
  }
  storageFailed ||= !storeDecisionOutbox(documentPath, entries, storage);
  return {
    entries,
    recoveryQuarantined: ambiguous.length > 0,
    storageFailed,
  };
}

export function markDecisionOutboxCommitted(
  current: readonly DecisionOutboxEntry[],
  committed: readonly DecisionEvent[],
): DecisionOutboxEntry[] {
  const ids = new Set(committed.map((event) => event.id));
  return current.map((entry) =>
    ids.has(entry.event.id) ? { ...entry, writeState: "committed" } : entry,
  );
}

export function removeDecisionOutboxEvents(
  current: readonly DecisionOutboxEntry[],
  acknowledged: readonly DecisionEvent[],
): DecisionOutboxEntry[] {
  const ids = new Set(acknowledged.map((event) => event.id));
  return current.filter(({ event }) => !ids.has(event.id));
}
