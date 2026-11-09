// ── #128 regression: the editor's saves never overlap ─────────────────────────
// Drives the REAL useDocSync hook against a REAL booted server over real HTTP and
// a real WebSocket. Only the browser surface the hook touches is stubbed. The bug
// needs the whole chain: a keystroke during a save's round trip, the server's
// echo of that save, a second PUT on the same base, the server's keep-both merge.

import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { startServer, type AcmServer } from "../../server";
import { useDocSync } from "./useDocSync";

type Sync = ReturnType<typeof useDocSync>;
type Put = { baseVersion: number; tail: string };
type Fault =
  | "never-reaches-server" // answered with a 500
  | "rejects-before-echo" // lands, but the request fails before its echo
  | "response-lost-after-echo" // lands, its echo arrives, its response is lost
  | "body-unreadable" // lands, its headers arrive, reading the body fails
  | "proxy-502"; // lands, then a proxy answers 502

const OPENING = "In Madrid it has involved sifting through";
const doc = (typed: string) => `# Post\n\n${OPENING}${typed}\n\nLast paragraph.\n`;
const elsewhere = (typed: string) =>
  doc(typed).replace("Last paragraph.", "Last paragraph, edited elsewhere.");

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
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "acm-xdg-"));
  for (const key of STUBBED) saved.set(key, globals[key]);
  const target = { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
  globals.window = target;
  globals.document = target;
  globals.IS_REACT_ACT_ENVIRONMENT = false;
  globals.IS_REACT_NATIVE_TEST_ENVIRONMENT = true; // silences the renderer's web deprecation notice
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
  // act() flushes the hook's effect cleanup, which needs the stubbed window.
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => renderer?.unmount());
  globals.IS_REACT_ACT_ENVIRONMENT = false;
  renderer = undefined;
  srv?.stop();
  srv = undefined;
});

async function until(
  what: string,
  ready: () => boolean | Promise<boolean>,
  ms = 4000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Boot a server on `seed`, mount the hook on it, and record every save. */
async function openEditor(seed: string) {
  const docPath = join(mkdtempSync(join(tmpdir(), "acm-doc-")), "doc.md");
  await Bun.write(docPath, seed);
  srv = startServer({ docPath, port: 0, staticDir: "./dist" });
  const origin = `127.0.0.1:${srv.server.port}`;
  globals.location = { protocol: "http:", host: origin };

  const puts: Put[] = [];
  const states: string[] = [];
  const remote: string[] = [];
  const putTimes: number[] = [];
  const unansweredPerPut: number[] = [];
  const io = {
    onPut: null as null | (() => Promise<void> | void), // runs once, as the next PUT leaves
    nextFault: null as null | Fault,
    pushes: 0, // WebSocket pushes delivered to the hook
    inFlight: 0,
    maxInFlight: 0,
  };

  globals.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).startsWith("/") ? `http://${origin}${input}` : input;
    if (init?.method !== "PUT" || !String(url).endsWith("/api/doc")) {
      return realFetch(url as string, init);
    }
    const body = JSON.parse(init.body as string) as {
      baseVersion: number;
      content: string;
      unansweredSaveIds: string[];
    };
    putTimes.push(Date.now());
    unansweredPerPut.push(body.unansweredSaveIds.length);
    puts.push({
      baseVersion: body.baseVersion,
      tail: body.content.split("\n")[2].slice(OPENING.length),
    });
    io.inFlight++;
    io.maxInFlight = Math.max(io.maxInFlight, io.inFlight);
    const onPut = io.onPut;
    io.onPut = null;
    await onPut?.();
    try {
      const fault = io.nextFault;
      io.nextFault = null;
      if (fault === "never-reaches-server") return new Response("boom", { status: 500 });
      if (fault === "rejects-before-echo") {
        void realFetch(url as string, init).catch(() => {});
        throw new TypeError("connection lost");
      }
      const before = io.pushes;
      const res = await realFetch(url as string, init);
      if (fault === "body-unreadable") {
        const broken = new ReadableStream({ start: (c) => c.error(new TypeError("connection lost")) });
        return new Response(broken, { status: 200 });
      }
      if (fault === "proxy-502") {
        return new Response("bad gateway", { status: 502 });
      }
      if (fault === "response-lost-after-echo") {
        await until("the save's echo", () => io.pushes > before);
        throw new TypeError("connection lost");
      }
      return res;
    } finally {
      io.inFlight--;
    }
  };

  globals.WebSocket = class extends RealWebSocket {
    constructor(url: string) {
      super(url);
      this.addEventListener("message", () => io.pushes++);
    }
  };

  const hook: { current: Sync | null } = { current: null };
  function Probe() {
    const sync = useDocSync({
      author: "You",
      onRemoteUpdate: (content) => remote.push(content),
    });
    hook.current = sync;
    states.push(sync.saveState);
    return null;
  }
  renderer = create(createElement(Probe));
  await until("the editor to connect", () => hook.current?.connected === true);

  const onDisk = () => readFileSync(docPath, "utf8");
  const sync = () => hook.current as Sync;
  const settled = () =>
    until("saves to settle", () => io.inFlight === 0 && sync().saveState === "saved");
  const version = async () =>
    ((await (await realFetch(`http://${origin}/api/doc`)).json()) as { version: number }).version;
  return { docPath, puts, putTimes, unansweredPerPut, states, remote, io, onDisk, sync, settled, version };
}

type Editor = Awaited<ReturnType<typeof openEditor>>;

async function openEditorAfterFirstSave(): Promise<Editor> {
  const editor = await openEditor(doc(""));
  editor.sync().save(doc(" bur"));
  await until("the first save", () => editor.onDisk() === doc(" bur"));
  await editor.settled();
  return editor;
}

/** Saves `bure`, with one more key (`u`) landing as that save leaves. */
function typeBureAndKeepTyping(editor: Editor, fault: Fault | null = null): void {
  editor.io.nextFault = fault;
  editor.io.onPut = () => editor.sync().save(doc(" bureu"));
  editor.sync().save(doc(" bure"));
}

/** Keeps the next PUT from reaching the server until the returned function runs. */
function holdNextPut(io: { onPut: null | (() => Promise<void> | void) }): () => void {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  io.onPut = () => held;
  return () => release();
}

describe("editor saves never overlap (#128)", () => {
  test("a key typed during a save's round trip does not repeat the paragraph", async () => {
    const editor = await openEditorAfterFirstSave();

    // The key lands as the save leaves, so the server's echo of `bure` reaches an
    // editor already holding `bureu`.
    typeBureAndKeepTyping(editor);
    await until("the keystroke to be saved", () => editor.puts.length >= 3);
    await editor.settled();

    expect(editor.onDisk()).toBe(doc(" bureu"));
    expect(editor.puts).toEqual([
      { baseVersion: 0, tail: " bur" },
      { baseVersion: 1, tail: " bure" },
      { baseVersion: 2, tail: " bureu" },
    ]);
    expect(editor.io.maxInFlight).toBe(1);
    expect(editor.states).not.toContain("conflict");
  });

  test("a save whose response is lost after its echo is merged from, not repeated", async () => {
    const editor = await openEditorAfterFirstSave();

    typeBureAndKeepTyping(editor, "response-lost-after-echo");
    await until("the keystroke to be saved", () => editor.puts.length >= 3);
    await until("the save to finish", () => editor.io.inFlight === 0);

    expect(editor.onDisk()).toBe(doc(" bureu"));
    expect(editor.puts).toEqual([
      { baseVersion: 0, tail: " bur" },
      { baseVersion: 1, tail: " bure" },
      { baseVersion: 1, tail: " bureu" },
    ]);
  });

  test("a save that fails before its echo is merged from, not repeated", async () => {
    const editor = await openEditorAfterFirstSave();

    typeBureAndKeepTyping(editor, "rejects-before-echo");
    await until("the keystroke to be saved", () => editor.puts.length >= 3);
    await until("the save to finish", () => editor.io.inFlight === 0);

    expect(editor.onDisk()).toBe(doc(" bureu"));
    expect(editor.puts).toEqual([
      { baseVersion: 0, tail: " bur" },
      { baseVersion: 1, tail: " bure" },
      { baseVersion: 1, tail: " bureu" },
    ]);
  });

  test("a flush queued behind a save that fails sends nothing until the reconnect", async () => {
    const editor = await openEditorAfterFirstSave();

    editor.io.nextFault = "rejects-before-echo";
    editor.io.onPut = () => {
      editor.sync().save(doc(" bureu"));
      editor.sync().flushNow();
    };
    editor.sync().save(doc(" bure"));
    await until("the keystroke to be saved", () => editor.puts.length >= 3);
    await until("the save to finish", () => editor.io.inFlight === 0);

    // The failed request may still be travelling, so the retry waits for the
    // reconnect (RECONNECT_MIN_MS is 500) instead of racing it.
    expect(editor.putTimes[2] - editor.putTimes[1]).toBeGreaterThanOrEqual(400);
    expect(editor.onDisk()).toBe(doc(" bureu"));
    expect(editor.puts).toEqual([
      { baseVersion: 0, tail: " bur" },
      { baseVersion: 1, tail: " bure" },
      { baseVersion: 1, tail: " bureu" },
    ]);
  });

  test("another writer's edit before the retry still merges with an unanswered save", async () => {
    const editor = await openEditorAfterFirstSave();

    typeBureAndKeepTyping(editor, "rejects-before-echo");
    await until("the failed save to land", () => editor.onDisk() === doc(" bure"));
    await Bun.write(editor.docPath, elsewhere(" bure"));
    await until("the retry", () => editor.puts.length >= 3);
    await until("the save to finish", () => editor.io.inFlight === 0);

    expect(editor.onDisk()).toBe(elsewhere(" bureu"));
  });

  test("a lost reply to a save the server merged keeps the other writer's edit", async () => {
    const editor = await openEditorAfterFirstSave();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    editor.io.nextFault = "response-lost-after-echo";
    editor.io.onPut = async () => {
      editor.sync().save(doc(" bureu"));
      await held;
    };
    editor.sync().save(doc(" bure"));
    await until("the save to leave", () => editor.puts.length === 2);

    await Bun.write(editor.docPath, elsewhere(" bur"));
    await until("the server to see the other write", async () => (await editor.version()) === 2);
    release();
    await until("the retry", () => editor.puts.length >= 3);
    await until("the retry to land", () => editor.onDisk() === elsewhere(" bureu"));

    expect(editor.onDisk()).toBe(elsewhere(" bureu"));
  });

  test("an unanswered save is ignored once the editor has taken a newer version", async () => {
    const editor = await openEditor(doc(""));
    editor.io.nextFault = "response-lost-after-echo";
    editor.sync().save(doc(" bur"));
    await until("the failed save to land", () => editor.onDisk() === doc(" bur"));
    await until("the editor to reconnect", () => editor.sync().connected && editor.io.inFlight === 0);
    await editor.settled();

    await Bun.write(editor.docPath, doc(" bure"));
    await until("the editor to take the edit", () => editor.remote.includes(doc(" bure")));
    editor.sync().save(doc(" bureu"));
    await until("the next save", () => editor.onDisk() !== doc(" bure"));
    await editor.settled();

    expect(editor.onDisk()).toBe(doc(" bureu"));
  });

  test("a reply whose body cannot be read is treated as unanswered", async () => {
    const editor = await openEditorAfterFirstSave();

    typeBureAndKeepTyping(editor, "body-unreadable");
    await until("the retry", () => editor.puts.length >= 3);
    await until("the retry to land", () => editor.onDisk() === doc(" bureu"));
    await editor.settled();

    editor.sync().save(doc(" bureu records"));
    await until("the next save", () => editor.puts.length >= 4);
    await editor.settled();

    expect(editor.onDisk()).toBe(doc(" bureu records"));
    expect(editor.unansweredPerPut).toEqual([0, 0, 1, 0]);
  });

  test("a proxy error after the save landed is treated as unanswered", async () => {
    const editor = await openEditorAfterFirstSave();

    typeBureAndKeepTyping(editor, "proxy-502");
    await until("the retry", () => editor.puts.length >= 3);
    await until("the save to finish", () => editor.io.inFlight === 0);

    expect(editor.onDisk()).toBe(doc(" bureu"));
  });

  test("an unanswered save with nothing typed after it still takes the server's state", async () => {
    const editor = await openEditor(doc(""));
    editor.io.nextFault = "rejects-before-echo";
    editor.sync().save(doc(" bur"));
    await until("the failed save to land", () => editor.onDisk() === doc(" bur"));
    await Bun.write(editor.docPath, elsewhere(" bur"));
    await until("the editor to take the edit", () => editor.remote.includes(elsewhere(" bur")));

    expect(editor.onDisk()).toBe(elsewhere(" bur"));
  });

  test("a flush asked for mid-save waits for it, then sends on the new base", async () => {
    const editor = await openEditor(doc(""));
    const release = holdNextPut(editor.io);
    editor.sync().save(doc(" bur"));
    await until("the first save to leave", () => editor.puts.length === 1);

    // Blur / Cmd-S while that save is still on the wire.
    editor.sync().save(doc(" bure"));
    editor.sync().flushNow();
    await Bun.sleep(50);
    expect(editor.puts).toEqual([{ baseVersion: 0, tail: " bur" }]);

    release();
    await until("the held-back flush", () => editor.puts.length === 2);
    await editor.settled();

    expect(editor.puts).toEqual([
      { baseVersion: 0, tail: " bur" },
      { baseVersion: 1, tail: " bure" },
    ]);
    expect(editor.onDisk()).toBe(doc(" bure"));
    expect(editor.io.maxInFlight).toBe(1);
  });

  test("a flush asked for during a save that fails is still sent", async () => {
    const editor = await openEditor(doc(""));
    const release = holdNextPut(editor.io);
    editor.io.nextFault = "never-reaches-server";
    editor.sync().save(doc(" bur"));
    await until("the first save to leave", () => editor.puts.length === 1);

    editor.sync().flushNow(); // the failed save arms no timer, so only this resends
    release();
    await until("the requested retry", () => editor.puts.length === 2);
    await editor.settled();

    expect(editor.puts).toEqual([
      { baseVersion: 0, tail: " bur" },
      { baseVersion: 0, tail: " bur" },
    ]);
    expect(editor.onDisk()).toBe(doc(" bur"));
  });

  test("a settled save's content is no longer treated as its echo", async () => {
    const editor = await openEditorAfterFirstSave();
    await Bun.write(editor.docPath, elsewhere(" bur"));
    await until("the editor to adopt the edit", () => editor.remote.includes(elsewhere(" bur")));

    // Another writer puts back exactly what this editor last saved.
    await Bun.write(editor.docPath, doc(" bur"));
    await until("the editor to adopt the restoration", () => editor.remote.length === 2);

    expect(editor.remote).toEqual([elsewhere(" bur"), doc(" bur")]);
  });

  test("another writer's change during a save still merges in", async () => {
    const editor = await openEditor(doc(""));
    const release = holdNextPut(editor.io);
    editor.sync().save(doc(" bur"));
    await until("the save to leave", () => editor.puts.length === 1);

    await Bun.write(editor.docPath, elsewhere(""));
    await until("the server to see the other write", async () => (await editor.version()) === 1);

    release();
    const merged = elsewhere(" bur");
    await until("the merge to reach the editor", () => editor.remote.includes(merged));
    await editor.settled();

    expect(editor.onDisk()).toBe(merged);
    expect(editor.remote).toEqual([merged]);
    expect(editor.io.maxInFlight).toBe(1);
  });
});
