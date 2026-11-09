// ── Reconnect audit: saves and pushes across a dropped WebSocket (#21) ────────
// Drives the REAL useDocSync hook against a REAL booted server over real HTTP and
// a real WebSocket; only the browser surface the hook touches is stubbed. Each
// fault is held open with a promise, never timed, so the ordering is exact.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { startServer, type AcmServer } from "../../server";
import { useDocSync } from "../client/useDocSync";
import type { DecisionEvent } from "../lib/decision";

type Sync = ReturnType<typeof useDocSync>;

const globals = globalThis as unknown as Record<string, unknown>;
const STUBBED = ["window", "document", "location", "fetch", "WebSocket", "IS_REACT_ACT_ENVIRONMENT", "IS_REACT_NATIVE_TEST_ENVIRONMENT"];
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
const RealWebSocket = globalThis.WebSocket;
let prevXdg: string | undefined;
let srv: AcmServer | undefined;
let renderer: ReactTestRenderer | undefined;

beforeAll(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "acm-reconnect-xdg-"));
  for (const key of STUBBED) saved.set(key, globals[key]);
  const target = { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
  globals.window = target;
  globals.document = target;
  globals.IS_REACT_ACT_ENVIRONMENT = false;
  globals.IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
});

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
});

afterEach(async () => {
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => renderer?.unmount());
  globals.IS_REACT_ACT_ENVIRONMENT = false;
  renderer = undefined;
  if (srv) {
    srv.stop();
    srv.server.stop(true);
  }
  srv = undefined;
});

async function until(what: string, ready: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

function deferred() {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

async function openEditor(seed: string, opts: { failDecisionReads?: boolean } = {}) {
  const docPath = join(mkdtempSync(join(tmpdir(), "acm-reconnect-doc-")), "doc.md");
  await Bun.write(docPath, seed);
  srv = startServer({ docPath, port: 0, staticDir: "./dist" });
  const port = srv.server.port as number;
  const origin = `127.0.0.1:${port}`;
  globals.location = { protocol: "http:", host: origin };

  const puts: Array<{ baseVersion: number; content: string; serverEpoch: string }> = [];
  const remote: string[] = [];
  const io = {
    socket: null as WebSocket | null,
    refuseSockets: false, // new sockets dial a closed port, as during an outage
    failDecisionReads: opts.failDecisionReads ?? false,
    holdDecisionReads: null as Promise<void> | null,
    beforePutLeaves: null as null | (() => Promise<void> | void), // once
    afterPutAnswered: null as null | (() => Promise<void> | void), // once, held before the hook sees the reply
    rejectPutAfterLanding: false, // once
    rejectPutAfterEcho: false, // once, the echo delivered before the failure
    stripAuditFromReply: false, // once
    failDecisionPosts: false,
    decisionReadsHeld: 0,
    pushedVersions: [] as number[],
    inFlight: 0,
  };

  globals.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).startsWith("/") ? `http://${origin}${input}` : String(input);
    if (url.endsWith("/api/decisions") || url.endsWith("/api/decision-recovery")) {
      if (io.failDecisionReads && init?.method !== "POST") return new Response("down", { status: 503 });
      if (io.failDecisionPosts && init?.method === "POST") return new Response("down", { status: 503 });
      if (io.holdDecisionReads && init?.method !== "POST") {
        io.decisionReadsHeld++;
        await io.holdDecisionReads;
      }
      return realFetch(url, init);
    }
    if (init?.method !== "PUT" || !url.endsWith("/api/doc")) return realFetch(url, init);
    const body = JSON.parse(init.body as string) as { baseVersion: number; content: string; serverEpoch: string };
    puts.push({ baseVersion: body.baseVersion, content: body.content, serverEpoch: body.serverEpoch });
    io.inFlight++;
    try {
      const before = io.beforePutLeaves;
      io.beforePutLeaves = null;
      await before?.();
      const pushesBefore = io.pushedVersions.length;
      const res = await realFetch(url, init);
      if (io.rejectPutAfterEcho) {
        io.rejectPutAfterEcho = false;
        await until("the save's echo", () => io.pushedVersions.length > pushesBefore);
        throw new TypeError("connection lost");
      }
      if (io.rejectPutAfterLanding) {
        io.rejectPutAfterLanding = false;
        throw new TypeError("connection lost");
      }
      const after = io.afterPutAnswered;
      io.afterPutAnswered = null;
      await after?.();
      if (io.stripAuditFromReply) {
        io.stripAuditFromReply = false;
        const { audit: _audit, ...reply } = (await res.json()) as Record<string, unknown>;
        return Response.json(reply, { status: res.status });
      }
      return res;
    } finally {
      io.inFlight--;
    }
  };

  globals.WebSocket = class extends RealWebSocket {
    constructor(url: string) {
      super(io.refuseSockets ? "ws://127.0.0.1:1/ws" : url);
      io.socket = this;
      this.addEventListener("message", (ev) => {
        const msg = JSON.parse(String(ev.data)) as { type: string; version: number };
        if (msg.type === "update") io.pushedVersions.push(msg.version);
      });
    }
  };

  const hook: { current: Sync | null } = { current: null };
  function Probe() {
    const sync = useDocSync({ author: "You", onRemoteUpdate: (content) => remote.push(content) });
    hook.current = sync;
    return null;
  }
  renderer = create(createElement(Probe));
  await until("the editor to connect", () => hook.current?.connected === true);

  const sync = () => hook.current as Sync;
  const onDisk = () => readFileSync(docPath, "utf8");
  const serverDoc = async () => (await (await realFetch(`http://${origin}/api/doc`)).json()) as {
    content: string;
    version: number;
    path: string;
    serverEpoch: string;
  };
  const settled = () => until("saves to settle", () => io.inFlight === 0 && sync().saveState === "saved" && sync().connected);
  const agentWrite = async (base: string, content: string) => {
    const snap = await serverDoc();
    const res = await realFetch(`http://${origin}/api/agent-write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentPath: snap.path, base, content }),
    });
    expect(res.status).toBe(200);
  };
  const stopServer = () => {
    srv?.stop();
    srv?.server.stop(true);
    srv = undefined;
  };
  const startAgain = () => {
    srv = startServer({ docPath, port, staticDir: "./dist" });
  };
  return { docPath, puts, remote, io, sync, onDisk, serverDoc, settled, agentWrite, stopServer, startAgain };
}

const SEED = "# Post\n\nOpening paragraph.\n\nMiddle paragraph.\n\nLast paragraph.\n";
const opening = (doc: string, text: string) => doc.replace("Opening paragraph.", `Opening paragraph.${text}`);
const DECISION: DecisionEvent = {
  id: "reconnect-audit-1",
  timestamp: "2026-11-09T12:00:00.000Z",
  action: "resolve",
  actor: "You",
  source: "gui",
  target: { kind: "thread", id: "thread-1", threadId: "thread-1" },
  anchor: "wording",
  originalText: "wording and discussion",
  proposedText: null,
  resultingText: "wording",
};

describe("reconnect audit (#21)", () => {
  test("a server restart after a save whose reply was lost resumes saving the newer typing", async () => {
    const editor = await openEditor(SEED);
    const landed = opening(SEED, " Som");
    const typedOn = opening(SEED, " Some more");
    editor.io.refuseSockets = true; // the reconnect waits for the restarted server
    editor.io.rejectPutAfterLanding = true;
    editor.io.beforePutLeaves = () => editor.sync().save(typedOn);

    editor.sync().save(landed);
    await until("the save to land", () => editor.onDisk() === landed);
    await until("the editor to go offline", () => !editor.sync().connected && editor.io.inFlight === 0);
    editor.stopServer();
    editor.startAgain();
    editor.io.refuseSockets = false;
    await until("the newer typing to reach disk", () => editor.onDisk() === typedOn, 6000);
    await editor.settled();

    expect(editor.onDisk()).toBe(typedOn);
    expect(editor.puts.map((put) => put.content)).toEqual([landed, typedOn]);
    expect(editor.remote).toEqual([typedOn]);
  }, 15000);

  test("edits held offline past the server's version window still merge and reach disk", async () => {
    const editor = await openEditor(SEED);
    editor.io.refuseSockets = true;
    editor.io.socket?.close();
    await until("the editor to go offline", () => !editor.sync().connected);
    let theirs = SEED;
    for (let i = 0; i < 40; i++) {
      const next = theirs.replace("Last paragraph.", `Last paragraph.${i}`);
      await editor.agentWrite(theirs, next);
      theirs = next;
    }
    const typed = opening(SEED, " Typed offline.");

    editor.sync().save(typed);
    editor.io.refuseSockets = false;
    const merged = opening(theirs, " Typed offline.");
    await until("the merged buffer to reach disk", () => editor.onDisk() === merged, 6000);
    await editor.settled();

    expect(editor.onDisk()).toBe(merged);
    expect(editor.remote).toEqual([merged]);
  }, 15000);

  test("a save's late reply does not regress the base past a newer adopted push and duplicate a line", async () => {
    const editor = await openEditor(SEED);
    const mine = opening(SEED, " mine");
    const agents = opening(SEED, " mine agent");
    const typed = opening(SEED, " mine agent typed");
    const reply = deferred();
    editor.io.afterPutAnswered = () => reply.held;

    editor.sync().save(mine);
    await until("the save's echo", () => editor.onDisk() === mine && editor.sync().saveState === "saved");
    await editor.agentWrite(mine, agents);
    await until("the push to be adopted", () => editor.remote.includes(agents));
    reply.release();
    await until("the late reply", () => editor.io.inFlight === 0);
    editor.sync().save(typed);
    editor.sync().flushNow();
    await until("the next save", () => editor.puts.length === 2 && editor.io.inFlight === 0);
    await editor.settled();

    expect(editor.onDisk()).toBe(typed);
    expect(editor.puts.map((put) => [put.baseVersion, put.content])).toEqual([
      [0, mine],
      [2, typed],
    ]);
    expect(editor.remote).toEqual([agents]);
  }, 15000);

  test("typing during a restart's decision-history retry is neither overwritten nor stranded", async () => {
    const editor = await openEditor(SEED, { failDecisionReads: true });
    editor.stopServer();
    await until("the editor to go offline", () => !editor.sync().connected);
    const before = opening(SEED, " before");
    const during = opening(SEED, " before during");
    const retry = deferred();

    editor.sync().save(before);
    editor.io.failDecisionReads = false;
    editor.io.holdDecisionReads = retry.held;
    editor.startAgain();
    await until("the bootstrap retry to start", () => editor.io.decisionReadsHeld > 0, 6000);
    editor.sync().save(during);
    retry.release();
    await until("the latest typing to reach disk", () => editor.onDisk() === during, 6000);
    await until("the save to finish", () => editor.io.inFlight === 0);

    expect(editor.onDisk()).toBe(during);
    expect(editor.puts.map((put) => put.content)).toEqual([during]);
    expect(editor.remote).toEqual([during]);
  }, 15000);

  test("a push that arrives while a merged save is on the wire still reaches the editor", async () => {
    const editor = await openEditor(SEED);
    const typed = opening(SEED, " mine");
    const theirs = SEED.replace("Last paragraph.", "Last paragraph theirs.");
    const merged = opening(theirs, " mine");
    const newest = merged.replace("Middle paragraph.", "Middle paragraph agent.");
    const leaves = deferred();
    const reply = deferred();
    editor.io.beforePutLeaves = () => leaves.held;
    editor.io.afterPutAnswered = () => reply.held;

    editor.sync().save(typed);
    await until("the save to leave", () => editor.puts.length === 1);
    await editor.agentWrite(SEED, theirs);
    leaves.release();
    await until("the save to merge", () => editor.onDisk() === merged);
    await editor.agentWrite(merged, newest);
    await until("the newest push", () => editor.io.pushedVersions.includes(3));
    reply.release();
    await until("the reply", () => editor.io.inFlight === 0);
    await editor.settled();

    expect(editor.onDisk()).toBe(newest);
    expect(editor.remote).toEqual([merged, newest]);
  }, 15000);

  test("a delayed merged reply does not put its older content over a newer adopted push", async () => {
    const editor = await openEditor(SEED);
    const sent = opening(SEED, " mine");
    const theirs = SEED.replace("Last paragraph.", "Last paragraph theirs.");
    const merged = opening(theirs, " mine");
    const newest = merged.replace("Middle paragraph.", "Middle paragraph agent.");
    const reply = deferred();
    editor.io.afterPutAnswered = () => reply.held;
    editor.io.beforePutLeaves = async () => {
      await editor.agentWrite(SEED, theirs);
      editor.sync().save(merged); // the buffer reaches what the merge will produce
    };

    editor.sync().save(sent);
    await until("the merged save's echo", () => editor.io.pushedVersions.includes(2));
    await editor.agentWrite(merged, newest);
    await until("the newer push to be adopted", () => editor.remote.includes(newest));
    reply.release();
    await until("the delayed reply", () => editor.io.inFlight === 0);
    await editor.settled();

    expect(editor.onDisk()).toBe(newest);
    expect(editor.remote).toEqual([newest]);
  }, 15000);

  test("a late reply whose audit retry fails does not regress the base past a newer push", async () => {
    const editor = await openEditor(SEED);
    const mine = opening(SEED, " mine");
    const agents = opening(SEED, " mine agent");
    const typed = opening(SEED, " mine agent typed");
    const reply = deferred();
    editor.io.afterPutAnswered = () => reply.held;
    editor.io.stripAuditFromReply = true;

    editor.sync().save(mine, { enqueue: [DECISION], cancel: [] });
    await until("the save's echo", () => editor.io.pushedVersions.includes(1));
    await editor.agentWrite(mine, agents);
    await until("the push to be adopted", () => editor.remote.includes(agents));
    editor.io.failDecisionPosts = true;
    reply.release();
    await until("the late reply", () => editor.io.inFlight === 0 && editor.sync().saveState === "audit-error");
    editor.io.failDecisionPosts = false;
    editor.sync().save(typed);
    editor.sync().flushNow();
    await until("the next save", () => editor.puts.length === 2 && editor.io.inFlight === 0);
    await until("the next save to land", () => editor.onDisk() !== agents);

    expect(editor.onDisk()).toBe(typed);
    expect(editor.puts.map((put) => put.baseVersion)).toEqual([0, 2]);
  }, 15000);

  describe("a restart ignores an unanswered save the buffer no longer descends from", () => {
    const answered = opening(SEED, " once");
    const typedOn = (doc: string) => doc.replace("Middle paragraph.", "Middle paragraph typed.");
    const restoredAndTyped = typedOn(answered);

    async function loseReplyTo(editor: Awaited<ReturnType<typeof openEditor>>, content: string) {
      editor.io.rejectPutAfterEcho = true;
      editor.sync().save(content);
      await until("the reply to be lost", () => !editor.sync().connected && editor.io.inFlight === 0);
      await until("the reconnect", () => editor.sync().connected && editor.sync().saveState === "saved", 6000);
    }

    /** Type `typed` offline, restore the unanswered save on disk, then restart. */
    async function restartOntoRestoredDocument(editor: Awaited<ReturnType<typeof openEditor>>, typed: string) {
      editor.stopServer();
      await until("the editor to go offline", () => !editor.sync().connected);
      editor.sync().save(typed);
      await Bun.write(editor.docPath, answered);
      editor.startAgain();
      await until("the merge to reach disk", () => editor.onDisk() === restoredAndTyped, 6000);
      await editor.settled();
    }

    test("after a newer push was adopted", async () => {
      const editor = await openEditor(SEED);
      const adopted = answered.replace("Last paragraph.", "Last paragraph agent.");
      await loseReplyTo(editor, answered);
      await editor.agentWrite(answered, adopted);
      await until("the newer push to be adopted", () => editor.remote.includes(adopted));

      await restartOntoRestoredDocument(editor, typedOn(adopted));

      expect(editor.onDisk()).toBe(restoredAndTyped);
      expect(editor.remote).toEqual([adopted, restoredAndTyped]);
    }, 15000);

    test("after a later save was confirmed by its echo", async () => {
      const editor = await openEditor(SEED);
      const later = answered.replace("Last paragraph.", "Last paragraph later.");
      await loseReplyTo(editor, answered);
      await loseReplyTo(editor, later);

      await restartOntoRestoredDocument(editor, typedOn(later));

      expect(editor.onDisk()).toBe(restoredAndTyped);
      expect(editor.remote).toEqual([restoredAndTyped]);
    }, 15000);

    test("after an earlier restart rebaselined the editor", async () => {
      const editor = await openEditor(SEED);
      const rebaselined = answered.replace("Last paragraph.", "Last paragraph on disk.");
      await loseReplyTo(editor, answered);
      editor.stopServer();
      await until("the editor to go offline", () => !editor.sync().connected);
      await Bun.write(editor.docPath, rebaselined);
      editor.startAgain();
      await until("the rebaseline", () => editor.remote.includes(rebaselined) && editor.sync().connected, 6000);

      await restartOntoRestoredDocument(editor, typedOn(rebaselined));

      expect(editor.onDisk()).toBe(restoredAndTyped);
      expect(editor.remote).toEqual([rebaselined, restoredAndTyped]);
    }, 15000);
  });
});
