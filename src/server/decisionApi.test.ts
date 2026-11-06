import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startServer, type AcmServer } from "../../server";
import { appendDecisionEvent, decisionLogPath } from "./decisions";
import { decisionRecoveryPath } from "./decisionRecovery";
import type { DecisionEvent } from "../lib/decision";

const JSON_HEADERS = { "content-type": "application/json" };
const event: DecisionEvent = {
  id: "decision-api-001",
  timestamp: "2026-08-04T12:00:00.000Z",
  action: "accept",
  actor: "Luis",
  source: "gui",
  target: { kind: "comment", id: "comment-1", threadId: "thread-1" },
  anchor: "original clause",
  originalText: "original clause",
  proposedText: "replacement clause",
  resultingText: "replacement clause",
};

const live: AcmServer[] = [];
let previousXdg: string | undefined;

beforeAll(() => {
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "acm-decisions-xdg-"));
});
afterAll(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
});
afterEach(() => {
  while (live.length) live.pop()!.stop();
});

async function boot(seed = "before\n", opts: Record<string, unknown> = {}) {
  const docPath = join(mkdtempSync(join(tmpdir(), "acm-decisions-doc-")), "doc.md");
  await Bun.write(docPath, seed);
  return bootPath(docPath, opts);
}

async function bootPath(docPath: string, opts: Record<string, unknown> = {}) {
  const server = startServer({ docPath, port: 0, staticDir: "./dist", ...opts });
  live.push(server);
  return {
    acm: server,
    docPath,
    port: server.server.port,
    serverEpoch: server.serverEpoch,
    url: `http://127.0.0.1:${server.server.port}`,
  };
}

function stopLive(server: AcmServer) {
  const index = live.indexOf(server);
  if (index >= 0) live.splice(index, 1);
  server.stop();
}

async function putDoc(url: string, body: Record<string, unknown>) {
  const snapshot = (await (await fetch(`${url}/api/doc`)).json()) as {
    path: string;
    serverEpoch: string;
  };
  return fetch(`${url}/api/doc`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ documentPath: snapshot.path, ...body, serverEpoch: snapshot.serverEpoch }),
  });
}

describe("decision HTTP protocol", () => {
  test("GET identifies the server epoch and PUT rejects a stale epoch before writing", async () => {
    const { url, docPath, serverEpoch } = await boot();
    const snapshot = await (await fetch(`${url}/api/doc`)).json();
    expect(snapshot).toMatchObject({
      content: "before\n",
      version: 0,
      path: docPath,
      serverEpoch,
    });

    const response = await fetch(`${url}/api/doc`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        content: "after\n",
        baseVersion: 0,
        documentPath: docPath,
        serverEpoch: `${serverEpoch}-stale`,
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ conflict: "server-epoch" });
    expect(await Bun.file(docPath).text()).toBe("before\n");
  });

  test("PUT rejects a write without its document identity before writing", async () => {
    const { url, docPath, serverEpoch } = await boot();

    const response = await fetch(`${url}/api/doc`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        content: "after\n",
        baseVersion: 0,
        serverEpoch,
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      audit: {
        status: "failed",
        code: "document-mismatch",
        retryable: false,
      },
    });
    expect(await Bun.file(docPath).text()).toBe("before\n");
  });

  test("PUT commits the document then exposes its complete decision event", async () => {
    const { url, docPath } = await boot();
    const saved = await putDoc(url, {
      content: "after\n",
      baseVersion: 0,
      documentPath: docPath,
      decisionEvents: [event],
    });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      version: 1,
      content: "after\n",
      audit: { status: "persisted", decisionEventIds: [event.id] },
    });

    const decisions = await fetch(`${url}/api/decisions`);
    expect(decisions.status).toBe(200);
    expect(await decisions.json()).toEqual({ decisionEvents: [event] });
  });

  test("POST appends an idempotent audit-only outbox batch without changing the document", async () => {
    const { url, docPath } = await boot();

    const first = await fetch(`${url}/api/decisions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ documentPath: docPath, decisionEvents: [event] }),
    });
    const second = await fetch(`${url}/api/decisions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ documentPath: docPath, decisionEvents: [event] }),
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      audit: { status: "persisted", decisionEventIds: [event.id] },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      audit: { status: "persisted", decisionEventIds: [event.id] },
    });
    const doc = await fetch(`${url}/api/doc`);
    expect(await doc.json()).toMatchObject({ content: "before\n", version: 0 });
    const decisions = await fetch(`${url}/api/decisions`);
    expect(await decisions.json()).toEqual({ decisionEvents: [event] });
  });

  test("corrupt history remains visible while later decisions continue to persist", async () => {
    const { url, docPath } = await boot();
    const log = decisionLogPath(docPath);
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, `${JSON.stringify(event)}\n{"id":`);
    const next = { ...event, id: "decision-api-002" };

    const appended = await fetch(`${url}/api/decisions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ documentPath: docPath, decisionEvents: [next] }),
    });
    const decisions = await fetch(`${url}/api/decisions`);

    expect(appended.status).toBe(200);
    expect(await appended.json()).toEqual({
      audit: { status: "persisted", decisionEventIds: [next.id] },
    });
    expect(decisions.status).toBe(200);
    expect(await decisions.json()).toEqual({
      decisionEvents: [event, next],
      decisionHistoryIssues: [
        {
          line: 2,
          code: "invalid-json",
          message: "Decision history line 2 contains invalid JSON.",
        },
      ],
    });
  });

  test("POST rejects an outbox batch bound to a different document", async () => {
    const { url, docPath } = await boot();

    const response = await fetch(`${url}/api/decisions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ documentPath: `${docPath}.other`, decisionEvents: [event] }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      audit: {
        status: "failed",
        code: "document-mismatch",
        retryable: false,
      },
    });
    const decisions = await fetch(`${url}/api/decisions`);
    expect(await decisions.json()).toEqual({ decisionEvents: [] });
  });

  test("PUT rejects a decision bound to another document before writing", async () => {
    const { url, docPath } = await boot();

    const response = await putDoc(url, {
      content: "after\n",
      baseVersion: 0,
      documentPath: `${docPath}.other`,
      decisionEvents: [event],
    });

    expect(response.status).toBe(409);
    const doc = await fetch(`${url}/api/doc`);
    expect(await doc.json()).toMatchObject({ content: "before\n", version: 0 });
    const decisions = await fetch(`${url}/api/decisions`);
    expect(await decisions.json()).toEqual({ decisionEvents: [] });
  });

  test("PUT rejects a document-bound write to another document even without decisions", async () => {
    const { url, docPath } = await boot();

    const response = await putDoc(url, {
      content: "after\n",
      baseVersion: 0,
      documentPath: `${docPath}.other`,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      audit: {
        status: "failed",
        code: "document-mismatch",
        retryable: false,
      },
    });
    const doc = await fetch(`${url}/api/doc`);
    expect(await doc.json()).toMatchObject({ content: "before\n", version: 0 });
  });

  test("POST rejects malformed outbox events without recording a partial batch", async () => {
    const { url } = await boot();

    const response = await fetch(`${url}/api/decisions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ decisionEvents: [event, { ...event, id: "bad", actor: 42 }] }),
    });

    expect(response.status).toBe(400);
    const decisions = await fetch(`${url}/api/decisions`);
    expect(await decisions.json()).toEqual({ decisionEvents: [] });
  });

  test("POST exposes an outbox persistence failure with the complete retry payload", async () => {
    const { url, docPath } = await boot("before\n", {
      appendDecisionEvents: async () => {
        throw new Error("disk full");
      },
    });

    const response = await fetch(`${url}/api/decisions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ documentPath: docPath, decisionEvents: [event] }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      audit: {
        status: "failed",
        code: "decision-persistence",
        retryable: true,
        decisionEvents: [event],
        message: "disk full",
        recovery: { status: "stored" },
      },
    });
    const decisions = await fetch(`${url}/api/decisions`);
    expect(await decisions.json()).toEqual({ decisionEvents: [] });
  });

  test("a committed GUI decision survives restart on another port until audit retry succeeds", async () => {
    const first = await boot("before\n", {
      appendDecisionEvents: async () => {
        throw new Error("decision disk unavailable");
      },
    });
    const failed = await putDoc(first.url, {
      content: "after\n",
      baseVersion: 0,
      documentPath: first.docPath,
      decisionEvents: [event],
    });

    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      version: 1,
      content: "after\n",
      audit: {
        status: "failed",
        code: "decision-persistence",
        retryable: true,
        decisionEvents: [event],
        recovery: { status: "stored" },
      },
    });
    stopLive(first.acm);

    const occupiedOldPort = Bun.serve({
      hostname: "127.0.0.1",
      port: first.port,
      fetch: () => new Response("occupied"),
    });
    try {
      const reopened = await bootPath(first.docPath);
      expect(reopened.port).not.toBe(first.port);
      const recovery = await fetch(`${reopened.url}/api/decision-recovery`);
      expect(recovery.status).toBe(200);
      expect(await recovery.json()).toEqual({ decisionEvents: [event] });

      const retried = await fetch(`${reopened.url}/api/decisions`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          documentPath: first.docPath,
          decisionEvents: [event],
        }),
      });
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual({
        audit: { status: "persisted", decisionEventIds: [event.id] },
      });
      expect(await (await fetch(`${reopened.url}/api/decision-recovery`)).json()).toEqual({
        decisionEvents: [],
      });
      expect(await (await fetch(`${reopened.url}/api/decisions`)).json()).toEqual({
        decisionEvents: [event],
      });
    } finally {
      occupiedOldPort.stop();
    }
  });

  test("an audit-only persistence failure is retained by the server recovery store", async () => {
    const { url, docPath } = await boot("before\n", {
      appendDecisionEvents: async () => {
        throw new Error("decision disk unavailable");
      },
    });

    const response = await fetch(`${url}/api/decisions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ documentPath: docPath, decisionEvents: [event] }),
    });

    expect(response.status).toBe(500);
    expect(await (await fetch(`${url}/api/decision-recovery`)).json()).toEqual({
      decisionEvents: [event],
    });
  });

  test("a decision recovery storage failure is explicit in the failed save response", async () => {
    const { url, docPath } = await boot("before\n", {
      appendDecisionEvents: async () => {
        throw new Error("decision disk unavailable");
      },
      storeDecisionRecoveryEvents: async () => {
        throw new Error("recovery disk unavailable");
      },
    });

    const response = await putDoc(url, {
      content: "after\n",
      baseVersion: 0,
      documentPath: docPath,
      decisionEvents: [event],
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      version: 1,
      content: "after\n",
      audit: {
        status: "failed",
        code: "decision-persistence",
        retryable: true,
        decisionEvents: [event],
        recovery: {
          status: "failed",
          message: "recovery disk unavailable",
        },
      },
    });
  });

  test("a recovery cleanup failure warns without failing an already durable save", async () => {
    const { url, docPath } = await boot("before\n", {
      clearDecisionRecoveryEvents: async () => {
        throw new Error("recovery cleanup unavailable");
      },
    });

    const response = await putDoc(url, {
      content: "after\n",
      baseVersion: 0,
      documentPath: docPath,
      decisionEvents: [event],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      content: "after\n",
      audit: {
        status: "persisted",
        decisionEventIds: [event.id],
        recovery: {
          status: "failed",
          message: "recovery cleanup unavailable",
        },
      },
    });
    expect(await (await fetch(`${url}/api/decisions`)).json()).toEqual({
      decisionEvents: [event],
    });
  });

  test("corrupt recovery evidence is reported without being discarded", async () => {
    const { url, docPath } = await boot();
    const path = decisionRecoveryPath(docPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not-json");

    const response = await fetch(`${url}/api/decision-recovery`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "decision-recovery-unreadable",
        message: expect.stringContaining("contains invalid JSON"),
      },
    });
    expect(await Bun.file(path).text()).toBe("{not-json");
  });

  test("a durable decision quarantines corrupt recovery evidence and future reads converge", async () => {
    const { url, docPath } = await boot();
    const path = decisionRecoveryPath(docPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not-json");

    const response = await putDoc(url, {
      content: "after\n",
      baseVersion: 0,
      documentPath: docPath,
      decisionEvents: [event],
    });
    const body = (await response.json()) as {
      audit: { recovery: { status: string; path: string } };
    };

    expect(response.status).toBe(200);
    expect(body.audit.recovery.status).toBe("quarantined");
    expect(await Bun.file(body.audit.recovery.path).text()).toBe("{not-json");
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await (await fetch(`${url}/api/decision-recovery`)).json()).toEqual({
      decisionEvents: [],
    });
    expect(await (await fetch(`${url}/api/decisions`)).json()).toEqual({
      decisionEvents: [event],
    });
  });

  test("an agent write audit failure is not retained after the CLI compensation boundary", async () => {
    const { url, docPath } = await boot("before\n", {
      appendDecisionEvents: async () => {
        throw new Error("decision disk unavailable");
      },
    });

    const response = await fetch(`${url}/api/agent-write`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        base: "before\n",
        content: "after\n",
        documentPath: docPath,
        decisionEvents: [event],
      }),
    });

    expect(response.status).toBe(500);
    expect(await (await fetch(`${url}/api/decision-recovery`)).json()).toEqual({
      decisionEvents: [],
    });
  });

  test("a conflict records no ghost event", async () => {
    const { url, docPath } = await boot();
    const first = await putDoc(url, { content: "server\n", baseVersion: 0 });
    expect(first.status).toBe(200);

    // A base the server no longer holds is refused as stale (a same-line clash
    // with a known base now merges, #88).
    const conflict = await putDoc(url, {
      content: "client\n",
      baseVersion: 99,
      documentPath: docPath,
      decisionEvents: [event],
    });
    expect(conflict.status).toBe(409);

    const decisions = await fetch(`${url}/api/decisions`);
    expect(decisions.status).toBe(200);
    expect(await decisions.json()).toEqual({ decisionEvents: [] });
  });

  test("an audit persistence failure is visible and retryable after the document commits", async () => {
    const { url, docPath } = await boot("before\n", {
      appendDecisionEvent: async () => {
        throw new Error("disk full");
      },
    });
    const response = await putDoc(url, {
      content: "after\n",
      baseVersion: 0,
      documentPath: docPath,
      decisionEvents: [event],
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      version: 1,
      content: "after\n",
      audit: {
        status: "failed",
        code: "decision-persistence",
        retryable: true,
        decisionEvents: [event],
        recovery: { status: "stored" },
      },
    });
  });

  test("retrying the confirmed version appends the event without rewriting the document", async () => {
    let failOnce = true;
    const { url, docPath } = await boot("before\n", {
      appendDecisionEvent: async (docPath: string, decision: typeof event) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("temporary failure");
        }
        return appendDecisionEvent(docPath, decision);
      },
    });
    const first = await putDoc(url, {
      content: "after\n",
      baseVersion: 0,
      documentPath: docPath,
      decisionEvents: [event],
    });
    expect(first.status).toBe(500);

    const retry = await putDoc(url, {
      content: "after\n",
      baseVersion: 1,
      documentPath: docPath,
      decisionEvents: [event],
    });

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      version: 1,
      content: "after\n",
      audit: { status: "persisted", decisionEventIds: [event.id] },
    });
    const decisions = await fetch(`${url}/api/decisions`);
    expect(await decisions.json()).toEqual({ decisionEvents: [event] });
  });

  test("agent writes use the same decision protocol as GUI saves", async () => {
    const { url, docPath } = await boot();

    const saved = await fetch(`${url}/api/agent-write`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        base: "before\n",
        content: "after\n",
        documentPath: docPath,
        decisionEvents: [event],
      }),
    });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      version: 1,
      content: "after\n",
      audit: { status: "persisted", decisionEventIds: [event.id] },
    });
    const decisions = await fetch(`${url}/api/decisions`);
    expect(await decisions.json()).toEqual({ decisionEvents: [event] });
  });

  test("agent writes reject a missing document identity before writing", async () => {
    const { url, docPath } = await boot();

    const response = await fetch(`${url}/api/agent-write`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        base: "before\n",
        content: "after\n",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      audit: {
        status: "failed",
        code: "document-mismatch",
        retryable: false,
      },
    });
    expect(await Bun.file(docPath).text()).toBe("before\n");
  });

  test("agent writes reject a decision bound to another document before writing", async () => {
    const { url, docPath } = await boot();

    const response = await fetch(`${url}/api/agent-write`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        base: "before\n",
        content: "after\n",
        documentPath: `${docPath}.other`,
        decisionEvents: [event],
      }),
    });

    expect(response.status).toBe(409);
    const doc = await fetch(`${url}/api/doc`);
    expect(await doc.json()).toMatchObject({ content: "before\n", version: 0 });
    const decisions = await fetch(`${url}/api/decisions`);
    expect(await decisions.json()).toEqual({ decisionEvents: [] });
  });

  test("agent writes reject another document path even without decision events", async () => {
    const { url, docPath } = await boot();

    const response = await fetch(`${url}/api/agent-write`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        base: "before\n",
        content: "after\n",
        documentPath: `${docPath}.other`,
        decisionEvents: [],
      }),
    });

    expect(response.status).toBe(409);
    const doc = await fetch(`${url}/api/doc`);
    expect(await doc.json()).toMatchObject({ content: "before\n", version: 0 });
  });

  test("invalid decision events are rejected before any document write", async () => {
    const { url } = await boot();

    const response = await putDoc(url, {
      content: "after\n",
      baseVersion: 0,
      decisionEvents: [{ ...event, actor: 42 }],
    });

    expect(response.status).toBe(400);
    const doc = await fetch(`${url}/api/doc`);
    expect(await doc.json()).toMatchObject({ content: "before\n", version: 0 });
    const decisions = await fetch(`${url}/api/decisions`);
    expect(await decisions.json()).toEqual({ decisionEvents: [] });
  });
});
