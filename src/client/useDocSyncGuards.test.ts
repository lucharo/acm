import { describe, expect, test } from "bun:test";

import {
  auditEndpointReadyForEpoch,
  canQuerySelectionProvenance,
  decisionEntriesForFlush,
  decisionEventsForAuditRetry,
  fetchDecisionRecoveryEvents,
  fetchPersistedDecisionEventIds,
  parseDocSnapshot,
  planDecisionBootstrap,
  planServerEpochReconnect,
  postDecisionEvents,
  probeDecisionEndpoint,
  reconnectSnapshotMatchesDocument,
  reconnectSnapshotStartsNewEpoch,
  reconnectSnapshotNeedsStateRestore,
  saveResponseMatchesCurrentEpoch,
  unloadWouldLoseEdits,
} from "./useDocSync";
import type { DecisionEvent } from "../lib/decision";

const EVENT: DecisionEvent = {
  id: "guard-1",
  timestamp: "2026-08-06T12:00:00.000Z",
  action: "resolve",
  actor: "Luis",
  source: "gui",
  target: { kind: "thread", id: "thread-1", threadId: "thread-1" },
  anchor: "wording",
  originalText: "wording and discussion",
  proposedText: null,
  resultingText: "wording",
};

describe("document sync guards", () => {
  test("selection provenance is queried only when the live buffer matches disk", () => {
    expect(canQuerySelectionProvenance("saved", true)).toBe(true);
    expect(canQuerySelectionProvenance("saved", false)).toBe(false);
    for (const state of [
      "unsaved",
      "saving",
      "offline",
      "conflict",
      "audit-error",
      "audit-recovery",
    ] as const) {
      expect(canQuerySelectionProvenance(state, true)).toBe(false);
    }
  });

  test("decision history reads distinguish persisted ids from an unavailable endpoint", async () => {
    const ready = (async () =>
      Response.json({
        decisionEvents: [
          { id: "persisted-1" },
          { id: 42 },
          null,
          { id: "persisted-2" },
        ],
      })) as unknown as typeof fetch;
    const unavailable = (async () =>
      new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

    expect(await fetchPersistedDecisionEventIds(ready, 20)).toEqual({
      status: "ready",
      value: new Set(["persisted-1", "persisted-2"]),
      needsReview: false,
    });
    expect(await fetchPersistedDecisionEventIds(unavailable, 20)).toEqual({
      status: "unavailable",
    });
  });

  test("decision history reads stop waiting when the endpoint hangs", async () => {
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;

    const result = await Promise.race([
      fetchPersistedDecisionEventIds(hanging, 10),
      new Promise<"test-timeout">((resolve) =>
        setTimeout(() => resolve("test-timeout"), 50),
      ),
    ]);

    expect(result).not.toBe("test-timeout");
    expect(result).toEqual({ status: "unavailable" });
  });

  test("readable decision history with corruption diagnostics still needs review", async () => {
    const corrupt = (async () =>
      Response.json({
        decisionEvents: [{ id: "persisted-1" }],
        decisionHistoryIssues: [
          {
            line: 2,
            code: "invalid-json",
            message: "Decision history line 2 contains invalid JSON.",
          },
        ],
      })) as unknown as typeof fetch;

    expect(await fetchPersistedDecisionEventIds(corrupt, 20)).toEqual({
      status: "ready",
      value: new Set(["persisted-1"]),
      needsReview: true,
    });
  });

  test("decision recovery reads require complete canonical events", async () => {
    const ready = (async () =>
      Response.json({ decisionEvents: [EVENT] })) as unknown as typeof fetch;
    const malformed = (async () =>
      Response.json({ decisionEvents: [{ ...EVENT, actor: 42 }] })) as unknown as typeof fetch;

    expect(await fetchDecisionRecoveryEvents(ready, 20)).toEqual({
      status: "ready",
      value: [EVENT],
      needsReview: false,
    });
    expect(await fetchDecisionRecoveryEvents(malformed, 20)).toEqual({
      status: "invalid",
    });
  });

  test("an unavailable decision bootstrap retries without claiming corruption", () => {
    expect(
      planDecisionBootstrap(
        { status: "unavailable" },
        { status: "ready", value: [EVENT], needsReview: false },
      ),
    ).toEqual({
      persistedEventIds: null,
      recoveredEvents: null,
      retryOnReconnect: true,
      needsReview: false,
    });
  });

  test("a malformed decision bootstrap remains visible as history needing review", () => {
    expect(
      planDecisionBootstrap(
        { status: "invalid" },
        { status: "ready", value: [EVENT], needsReview: false },
      ),
    ).toEqual({
      persistedEventIds: null,
      recoveredEvents: null,
      retryOnReconnect: true,
      needsReview: true,
    });
  });

  test("a complete decision bootstrap releases durable and recovered evidence", () => {
    expect(
      planDecisionBootstrap(
        { status: "ready", value: new Set([EVENT.id]), needsReview: false },
        { status: "ready", value: [EVENT], needsReview: false },
      ),
    ).toEqual({
      persistedEventIds: new Set([EVENT.id]),
      recoveredEvents: [EVENT],
      retryOnReconnect: false,
      needsReview: false,
    });
  });

  test("an audit retry distinguishes durable persistence from recovery cleanup warnings", async () => {
    const request = (async () =>
      Response.json({
        audit: {
          status: "persisted",
          decisionEventIds: [EVENT.id],
          recovery: { status: "failed", message: "recovery cleanup unavailable" },
        },
      })) as unknown as typeof fetch;

    expect(await postDecisionEvents("/docs/draft.md", [EVENT], request)).toEqual({
      persisted: true,
      recoveryNeedsReview: true,
    });
  });

  test("an audit retry uses the server's rebased committed coordinates", () => {
    const rebased = {
      ...EVENT,
      target: { ...EVENT.target, afterFrom: 12, afterTo: 19 },
    };

    expect(decisionEventsForAuditRetry([EVENT], [rebased])).toEqual([rebased]);
    expect(decisionEventsForAuditRetry([EVENT], [{ ...rebased, id: "other" }])).toEqual([EVENT]);
    expect(decisionEventsForAuditRetry([EVENT], [{ ...rebased, actor: 42 }])).toEqual([EVENT]);
  });

  test("audit-only retries exclude decisions without document-commit evidence", () => {
    const pending = { event: EVENT, writeState: "pending" as const };
    const committed = {
      event: { ...EVENT, id: "guard-2" },
      writeState: "committed" as const,
    };

    expect(decisionEntriesForFlush([pending, committed], false)).toEqual([committed]);
    expect(decisionEntriesForFlush([pending, committed], true)).toEqual([
      pending,
      committed,
    ]);
    expect(
      decisionEntriesForFlush(
        [pending, committed],
        true,
        new Set([pending.event.id]),
      ),
    ).toEqual([committed]);
  });
  test("audit endpoint readiness is scoped to one server epoch", () => {
    expect(auditEndpointReadyForEpoch("epoch-a", "epoch-a")).toBe(true);
    expect(auditEndpointReadyForEpoch("epoch-a", "epoch-b")).toBe(false);
    expect(auditEndpointReadyForEpoch(null, "epoch-a")).toBe(false);
  });

  test("a document snapshot must identify its server epoch", () => {
    expect(
      parseDocSnapshot({
        content: "Draft\n",
        version: 3,
        path: "/docs/draft.md",
        serverEpoch: "epoch-a",
      }),
    ).toEqual({
      content: "Draft\n",
      version: 3,
      path: "/docs/draft.md",
      serverEpoch: "epoch-a",
    });
    expect(() =>
      parseDocSnapshot({ content: "Draft\n", version: 3, path: "/docs/draft.md" }),
    ).toThrow("incompatible document snapshot");
  });

  test("a reconnect may flush pending work only to the same document", () => {
    expect(reconnectSnapshotMatchesDocument("/docs/first.md", "/docs/first.md")).toBe(true);
    expect(reconnectSnapshotMatchesDocument("/docs/first.md", "/docs/second.md")).toBe(false);
    expect(reconnectSnapshotMatchesDocument(null, "/docs/first.md")).toBe(false);
  });

  test("an equal-version verified reconnect restores the settled badge explicitly", () => {
    expect(reconnectSnapshotNeedsStateRestore(7, 7)).toBe(true);
    expect(reconnectSnapshotNeedsStateRestore(8, 7)).toBe(false);
    expect(reconnectSnapshotNeedsStateRestore(6, 7)).toBe(false);
  });

  test("a changed server epoch rebaselines equal and higher version collisions", () => {
    expect(
      reconnectSnapshotStartsNewEpoch({
        currentEpoch: "epoch-a",
        currentVersion: 7,
        snapshotEpoch: "epoch-b",
        snapshotVersion: 7,
      }),
    ).toBe(true);
    expect(
      reconnectSnapshotStartsNewEpoch({
        currentEpoch: "epoch-a",
        currentVersion: 7,
        snapshotEpoch: "epoch-b",
        snapshotVersion: 11,
      }),
    ).toBe(true);
    expect(
      reconnectSnapshotStartsNewEpoch({
        currentEpoch: "epoch-a",
        currentVersion: 7,
        snapshotEpoch: "epoch-a",
        snapshotVersion: 11,
      }),
    ).toBe(false);
  });

  test("an in-flight save response becomes stale when reconnect adopts a new epoch", () => {
    expect(saveResponseMatchesCurrentEpoch("epoch-a", "epoch-a")).toBe(true);
    expect(saveResponseMatchesCurrentEpoch("epoch-a", "epoch-b")).toBe(false);
    expect(saveResponseMatchesCurrentEpoch(null, "epoch-b")).toBe(false);
  });

  test("a restarted server rebases offline edits onto its fresh snapshot", () => {
    expect(
      planServerEpochReconnect({
        pendingContent: "First edited\nMiddle\nSecond\n",
        lastConfirmedContent: "First\nMiddle\nSecond\n",
        snapshotContent: "First\nMiddle\nSecond changed\n",
      }),
    ).toEqual({ kind: "flush", content: "First edited\nMiddle\nSecond changed\n" });
  });

  test("a restarted server keeps overlapping offline edits in conflict", () => {
    expect(
      planServerEpochReconnect({
        pendingContent: "First edited locally\n",
        lastConfirmedContent: "First\n",
        snapshotContent: "First edited remotely\n",
      }),
    ).toEqual({ kind: "conflict" });
  });

  test("an undo invalidates the decision snapshot captured before an asynchronous probe", async () => {
    let currentRevision = 4;
    let finishProbe!: (available: boolean) => void;
    const probe = new Promise<boolean>((resolve) => {
      finishProbe = resolve;
    });

    const result = probeDecisionEndpoint({
      snapshotRevision: currentRevision,
      currentRevision: () => currentRevision,
      snapshotEpoch: "epoch-a",
      currentEpoch: () => "epoch-a",
      probe: () => probe,
    });
    currentRevision += 1;
    finishProbe(true);

    expect(await result).toBe("stale");
  });

  test("a reconnect invalidates an asynchronous decision probe without mutating the new epoch", async () => {
    let currentEpoch = "epoch-a";
    let finishProbe!: (available: boolean) => void;
    const probe = new Promise<boolean>((resolve) => {
      finishProbe = resolve;
    });

    const result = probeDecisionEndpoint({
      snapshotRevision: 4,
      currentRevision: () => 4,
      snapshotEpoch: currentEpoch,
      currentEpoch: () => currentEpoch,
      probe: () => probe,
    });
    currentEpoch = "epoch-b";
    finishProbe(true);

    expect(await result).toBe("epoch-stale");
  });

  test("an unchanged decision snapshot distinguishes a ready endpoint from an unavailable one", async () => {
    expect(
      await probeDecisionEndpoint({
        snapshotRevision: 4,
        currentRevision: () => 4,
        snapshotEpoch: "epoch-a",
        currentEpoch: () => "epoch-a",
        probe: async () => true,
      }),
    ).toBe("ready");
    expect(
      await probeDecisionEndpoint({
        snapshotRevision: 4,
        currentRevision: () => 4,
        snapshotEpoch: "epoch-a",
        currentEpoch: () => "epoch-a",
        probe: async () => false,
      }),
    ).toBe("unavailable");
  });
});

describe("leaving the page", () => {
  test("warns while any edit is unconfirmed, and not once it is saved", () => {
    expect(unloadWouldLoseEdits("edited")).toBe(true);
    expect(unloadWouldLoseEdits(null)).toBe(false);
  });
});
