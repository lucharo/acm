import { describe, expect, test } from "bun:test";

import type { DecisionEvent } from "../lib/decision";
import {
  LEGACY_DECISION_OUTBOX_KEY,
  decisionOutboxKey,
  decisionOutboxQuarantineKey,
  legacyDecisionOutboxQuarantineKey,
  loadDecisionOutbox,
  loadDecisionOutboxState,
  markDecisionOutboxCommitted,
  mergeCommittedDecisionOutbox,
  mergeDecisionOutbox,
  reconcileDeferredDecisionOutbox,
  rebasePendingDecisionOutbox,
  removeDecisionOutboxEvents,
  storeDecisionOutbox,
  type DecisionOutboxEntry,
  type DecisionOutboxStorage,
} from "./decisionOutbox";

const EVENT: DecisionEvent = {
  id: "outbox-1",
  timestamp: "2026-08-05T12:00:00.000Z",
  action: "resolve",
  actor: "Luis",
  source: "gui",
  target: { kind: "thread", id: "thread-1", threadId: "thread-1" },
  anchor: "wording",
  originalText: "wording and discussion",
  proposedText: null,
  resultingText: "wording",
};
const PENDING: DecisionOutboxEntry = { event: EVENT, writeState: "pending" };
const COMMITTED: DecisionOutboxEntry = { event: EVENT, writeState: "committed" };

function memoryStorage(): DecisionOutboxStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe("decision audit outbox", () => {
  test("persists complete events across a cold load and removes the empty queue", () => {
    const storage = memoryStorage();
    const documentPath = "/docs/first.md";

    expect(storeDecisionOutbox(documentPath, [COMMITTED], storage)).toBe(true);
    expect(loadDecisionOutbox(documentPath, storage)).toEqual([EVENT]);

    expect(storeDecisionOutbox(documentPath, [], storage)).toBe(true);
    expect(storage.values.has(decisionOutboxKey(documentPath))).toBe(false);
  });

  test("keeps pending decisions isolated by document path", () => {
    const storage = memoryStorage();

    storeDecisionOutbox("/docs/first.md", [COMMITTED], storage);

    expect(loadDecisionOutbox("/docs/first.md", storage)).toEqual([EVENT]);
    expect(loadDecisionOutbox("/docs/second.md", storage)).toEqual([]);
  });

  test("does not replay a queued decision after a crash without document-commit evidence", () => {
    const storage = memoryStorage();
    const documentPath = "/docs/first.md";

    storeDecisionOutbox(documentPath, [PENDING], storage);

    expect(loadDecisionOutboxState(documentPath, storage)).toEqual({
      entries: [],
      events: [],
      legacyQuarantined: false,
      recoveryQuarantined: true,
      storageFailed: false,
      verificationDeferred: false,
    });
    expect(storage.getItem(decisionOutboxKey(documentPath))).toBeNull();
    expect(storage.getItem(decisionOutboxQuarantineKey(documentPath))).toContain(
      "document-commit-unconfirmed",
    );
  });

  test("deduplicates retries and removes only acknowledged event ids", () => {
    const second = { ...EVENT, id: "outbox-2" };

    const merged = mergeDecisionOutbox([COMMITTED], [EVENT, second]);

    expect(merged).toEqual([
      COMMITTED,
      { event: second, writeState: "pending" },
    ]);
    expect(removeDecisionOutboxEvents(merged, [EVENT])).toEqual([
      { event: second, writeState: "pending" },
    ]);
    expect(markDecisionOutboxCommitted(merged, [second])).toEqual([
      COMMITTED,
      { event: second, writeState: "committed" },
    ]);
  });

  test("rebases pending result ranges through later debounced edits", () => {
    const ranged = {
      ...EVENT,
      resultingText: "wording",
      target: { ...EVENT.target, afterFrom: 0, afterTo: 7 },
    };
    const committed = { event: ranged, writeState: "committed" as const };
    const pending = { event: ranged, writeState: "pending" as const };

    const rebased = rebasePendingDecisionOutbox(
      [committed, pending],
      "wording tail",
      "prefix wording tail",
    );

    expect(rebased).toEqual([
      committed,
      {
        writeState: "pending",
        event: {
          ...ranged,
          target: { ...ranged.target, afterFrom: 7, afterTo: 14 },
        },
      },
    ]);
  });

  test("merges server recovery events as committed work safe for audit-only retry", () => {
    const second = { ...EVENT, id: "outbox-2" };

    const merged = mergeCommittedDecisionOutbox([PENDING], [EVENT, second]);

    expect(merged).toEqual([
      { event: EVENT, writeState: "committed" },
      { event: second, writeState: "committed" },
    ]);
    expect(merged.filter((entry) => entry.writeState === "pending")).toEqual([]);
  });

  test("quarantines malformed persisted entries instead of partially replaying them", () => {
    const storage = memoryStorage();
    const documentPath = "/docs/first.md";
    storage.setItem(
      decisionOutboxKey(documentPath),
      JSON.stringify([EVENT, { ...EVENT, actor: 42 }]),
    );

    expect(loadDecisionOutbox(documentPath, storage)).toEqual([]);
    expect(storage.getItem(decisionOutboxQuarantineKey(documentPath))).toContain(
      "legacy-per-document",
    );
  });

  test("replays committed entries while quarantining pending entries from the same queue", () => {
    const storage = memoryStorage();
    const documentPath = "/docs/first.md";
    const second = { ...EVENT, id: "outbox-2" };
    storeDecisionOutbox(
      documentPath,
      [COMMITTED, { event: second, writeState: "pending" }],
      storage,
    );

    expect(loadDecisionOutboxState(documentPath, storage)).toEqual({
      entries: [COMMITTED],
      events: [EVENT],
      legacyQuarantined: false,
      recoveryQuarantined: true,
      storageFailed: false,
      verificationDeferred: false,
    });
  });

  test("drops an outbox entry whose event is already in durable history", () => {
    const storage = memoryStorage();
    const documentPath = "/docs/first.md";
    storeDecisionOutbox(documentPath, [PENDING], storage);

    expect(loadDecisionOutboxState(documentPath, storage, new Set([EVENT.id]))).toEqual({
      entries: [],
      events: [],
      legacyQuarantined: false,
      recoveryQuarantined: false,
      storageFailed: false,
      verificationDeferred: false,
    });
    expect(storage.getItem(decisionOutboxKey(documentPath))).toBeNull();
  });

  test("defers pending-entry recovery when durable history could not be read", () => {
    const storage = memoryStorage();
    const documentPath = "/docs/first.md";
    storeDecisionOutbox(documentPath, [PENDING], storage);

    expect(loadDecisionOutboxState(documentPath, storage, null)).toEqual({
      entries: [PENDING],
      events: [],
      legacyQuarantined: false,
      recoveryQuarantined: false,
      storageFailed: false,
      verificationDeferred: true,
    });
    expect(storage.getItem(decisionOutboxKey(documentPath))).not.toBeNull();
    expect(storage.getItem(decisionOutboxQuarantineKey(documentPath))).toBeNull();
  });

  test("releases a deferred decision once durable history becomes readable", () => {
    const storage = memoryStorage();
    const documentPath = "/docs/first.md";
    storeDecisionOutbox(documentPath, [PENDING], storage);

    expect(
      reconcileDeferredDecisionOutbox(
        documentPath,
        [PENDING],
        new Set([EVENT.id]),
        new Set([EVENT.id]),
        [],
        storage,
      ),
    ).toEqual({
      entries: [],
      recoveryQuarantined: false,
      storageFailed: false,
    });
    expect(storage.getItem(decisionOutboxKey(documentPath))).toBeNull();
    expect(storage.getItem(decisionOutboxQuarantineKey(documentPath))).toBeNull();
  });

  test("a bootstrap retry preserves decisions queued after the failed read", () => {
    const storage = memoryStorage();
    const documentPath = "/docs/first.md";
    const later = { ...EVENT, id: "outbox-2" };
    const laterPending = { event: later, writeState: "pending" as const };

    expect(
      reconcileDeferredDecisionOutbox(
        documentPath,
        [PENDING, laterPending],
        new Set([EVENT.id]),
        new Set(),
        [EVENT],
        storage,
      ),
    ).toEqual({
      entries: [{ event: EVENT, writeState: "committed" }, laterPending],
      recoveryQuarantined: false,
      storageFailed: false,
    });
    expect(JSON.parse(storage.getItem(decisionOutboxKey(documentPath))!)).toEqual({
      version: 2,
      entries: [{ event: EVENT, writeState: "committed" }, laterPending],
    });
  });

  test("a bootstrap retry quarantines a deferred decision with no commit evidence", () => {
    const storage = memoryStorage();
    const documentPath = "/docs/first.md";

    expect(
      reconcileDeferredDecisionOutbox(
        documentPath,
        [PENDING],
        new Set([EVENT.id]),
        new Set(),
        [],
        storage,
      ),
    ).toEqual({
      entries: [],
      recoveryQuarantined: true,
      storageFailed: false,
    });
    expect(storage.getItem(decisionOutboxQuarantineKey(documentPath))).toContain(
      "document-commit-unconfirmed",
    );
  });

  test("quarantines an unscoped legacy outbox instead of replaying it into an unknown document", () => {
    const storage = memoryStorage();
    const documentPath = "/docs/first.md";
    const legacyValue = JSON.stringify([EVENT]);
    storage.setItem(LEGACY_DECISION_OUTBOX_KEY, legacyValue);

    expect(loadDecisionOutboxState(documentPath, storage)).toEqual({
      entries: [],
      events: [],
      legacyQuarantined: true,
      recoveryQuarantined: false,
      storageFailed: false,
      verificationDeferred: false,
    });
    expect(storage.getItem(LEGACY_DECISION_OUTBOX_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(legacyDecisionOutboxQuarantineKey())!)).toEqual({
      reason: "legacy-unscoped",
      raw: legacyValue,
    });
    expect(storage.getItem(decisionOutboxKey(documentPath))).toBeNull();
  });

  test("reports browser-storage failure instead of pretending the outbox is durable", () => {
    const storage: DecisionOutboxStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("storage unavailable");
      },
    };

    expect(storeDecisionOutbox("/docs/first.md", [PENDING], storage)).toBe(false);
  });

  test("does not show a cold-start audit error before any decision needs storage", () => {
    expect(loadDecisionOutboxState("/docs/first.md", null)).toEqual({
      entries: [],
      events: [],
      legacyQuarantined: false,
      recoveryQuarantined: false,
      storageFailed: false,
      verificationDeferred: false,
    });
  });

  test("reports an actual browser-storage read failure", () => {
    const storage: DecisionOutboxStorage = {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {},
      removeItem: () => {},
    };

    expect(loadDecisionOutboxState("/docs/first.md", storage)).toEqual({
      entries: [],
      events: [],
      legacyQuarantined: false,
      recoveryQuarantined: false,
      storageFailed: true,
      verificationDeferred: false,
    });
  });
});
