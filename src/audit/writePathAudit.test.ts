// ── Editing-API audit: server routes, CLI verbs, save protocol ────────────────
// Defects found by the 2026-11 correctness audit, pinned as `test.failing` so CI
// stays green until each is fixed (then the test passes its assertions, bun
// reports it, and the fix flips it to `test`). Issue numbers in the names.
// Every server and CLI run here uses a temp XDG_CONFIG_HOME and temp documents.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../../server";
import type { AcmServer } from "../../server";
import { reconcileSave } from "../client/reconcile";
import { recordHistory, listHistory } from "../server/history";

const CLI = resolve(import.meta.dir, "../../cli.ts");
const J = { "content-type": "application/json" };
const live: AcmServer[] = [];
let prevXdg: string | undefined;
let xdg: string;

beforeAll(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  xdg = mkdtempSync(join(tmpdir(), "acm-audit-xdg-"));
  process.env.XDG_CONFIG_HOME = xdg;
});
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
});
afterEach(() => {
  while (live.length) live.pop()!.stop();
});

async function boot(seed: string, docPath?: string) {
  const path = docPath ?? join(mkdtempSync(join(tmpdir(), "acm-audit-doc-")), "doc.md");
  await Bun.write(path, seed);
  const srv = startServer({ docPath: path, port: 0, staticDir: "./dist" });
  live.push(srv);
  const url = `http://127.0.0.1:${srv.server.port}`;
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${url}/api/doc`);
      if (r.ok) {
        const s = (await r.json()) as { path: string; serverEpoch: string; version: number; content: string };
        return { url, docPath: path, path: s.path, epoch: s.serverEpoch };
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(10);
  }
  throw new Error("audit server failed to start");
}
type Booted = Awaited<ReturnType<typeof boot>>;

const put = async (b: Booted, body: Record<string, unknown>) => {
  const r = await fetch(`${b.url}/api/doc`, {
    method: "PUT",
    headers: J,
    body: JSON.stringify({ documentPath: b.path, serverEpoch: b.epoch, ...body }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { version?: number; content?: string; conflict?: string } };
};
const agentWrite = async (b: Booted, base: string, content: string) =>
  (await fetch(`${b.url}/api/agent-write`, {
    method: "POST",
    headers: J,
    body: JSON.stringify({ documentPath: b.path, base, content }),
  })).status;
const presence = (b: Booted, from: number, to: number) =>
  fetch(`${b.url}/api/presence`, { method: "PUT", headers: J, body: JSON.stringify({ documentPath: b.path, from, to }) });
/** Keep the human's presence fresh while `run` executes: the server expires a
 *  presence after a few seconds, and a slow CLI start must not outlive it. */
async function withPresence<T>(b: Booted, from: number, to: number, run: () => Promise<T>): Promise<T> {
  await presence(b, from, to);
  const pending = new Set<Promise<unknown>>();
  const timer = setInterval(() => {
    const beat = presence(b, from, to).catch(() => undefined); // never an unhandled rejection
    pending.add(beat);
    void beat.finally(() => pending.delete(beat));
  }, 1000);
  try {
    return await run();
  } finally {
    clearInterval(timer);
    await Promise.all(pending); // drain in-flight beats before afterEach stops the server
  }
}
// CLI tests spawn `bun cli.ts`, which can take many seconds under load: give them room
// past bun's 5 s default, and keep the subprocess budget inside the test's deadline.
const CLI_TIMEOUT = 60_000;
const CLI_SPAWN_TIMEOUT = 45_000;
const getDoc = async (b: Booted) => (await (await fetch(`${b.url}/api/doc`)).json()) as { content: string; version: number };

// Async spawn: a spawnSync would block this process's event loop, so the in-process
// test server could never answer the CLI's live write (it would time out instead).
async function cli(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const e: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: xdg, ...env };
  delete e.ACM_AUTHOR;
  if (!("ACM_DOC" in env)) delete e.ACM_DOC;
  const p = Bun.spawn(["bun", CLI, ...args], {
    cwd: cwd ?? resolve(import.meta.dir, "../.."),
    env: e,
    stdout: "pipe",
    stderr: "pipe",
    timeout: CLI_SPAWN_TIMEOUT,
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  // A killed CLI never ran the verb: its exit code and an untouched document would read
  // like a fix. Throw instead, so a `test.failing` stays "still broken", never "fixed".
  if (p.signalCode !== null) throw new Error(`acm ${args[0]} was killed (${p.signalCode}) before finishing`);
  return { code, out: out + err };
}

describe("audit: PUT /api/doc input validation", () => {
  test("#90 a non-string `content` is rejected with 400 and never written", async () => {
    const seed = "Para one.\n\nPara two.\n";
    const b = await boot(seed);
    const r = await put(b, { baseVersion: 0, content: 42 });
    expect({ status: r.status, disk: readFileSync(b.docPath, "utf8") }).toEqual({ status: 400, disk: seed });
  });
});

describe("audit: save protocol", () => {
  test.failing("#88 after a same-line conflict with an agent write, the human's edit still reaches disk", async () => {
    const seed = "alpha line\nbeta line\n";
    const b = await boot(seed);
    expect(await agentWrite(b, seed, "alpha line{>>@claude: note<<}\nbeta line\n")).toBe(200);
    // The editor still holds version 0 and its buffer edits the same line. Follow
    // reconcileSave exactly as useDocSync does: on "conflict" keep the version.
    let version = 0;
    let buffer = "alpha line HUMAN\nbeta line\n";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 1) buffer = "alpha line HUMAN\nbeta line HUMAN2\n"; // keeps typing elsewhere
      const r = await put(b, { baseVersion: version, content: buffer });
      const d = reconcileSave({ status: r.status, version: r.body.version, serverContent: r.body.content, sent: buffer, buffer });
      if (d.kind === "saved" || d.kind === "reflush" || d.kind === "rebased") break;
      if (d.kind !== "conflict") throw new Error(`unexpected ${d.kind}`);
    }
    expect(readFileSync(b.docPath, "utf8")).toContain("HUMAN");
  });

  test("#92 a document that starts with a UTF-8 BOM can save an edit to its first line", async () => {
    const b = await boot("\uFEFF# Title\n\nPara one.\n");
    const snap = await getDoc(b);
    const r = await put(b, { baseVersion: snap.version, content: snap.content.replace("# Title", "# Title EDITED") });
    expect(r.status).toBe(200);
    expect(readFileSync(b.docPath, "utf8")).toContain("# Title EDITED");
  });
});

describe("audit: cursor guard", () => {
  test("#98 an agent write with a stale base is still refused inside the human's active span", async () => {
    const seed = "Intro.\n\nTarget sentence here.\n";
    const b = await boot(seed);
    const human = "A".repeat(300) + "\n\n" + seed;
    expect((await put(b, { baseVersion: 0, content: human })).status).toBe(200);
    const at = human.indexOf("Target");
    await presence(b, at, at + 6); // caret on "Target", current-document offsets
    const card = seed.replace("Target sentence here.", "{==Target==}{>>@claude: SUGGEST: Goal<<} sentence here.");
    expect(await agentWrite(b, seed, card)).toBe(409); // base read before the human's save
  });
});

describe("audit: CLI routing to a live instance", () => {
  // #100's history fixture is built before any server starts (startServer records
  // history fire-and-forget, which would race it) and checked here, outside the
  // inverted test, so a broken fixture fails loudly instead of passing test.failing.
  const restoreSeed = "First version.\n";
  let restoreDoc = "";
  let restoreRef = "";
  beforeAll(async () => {
    restoreDoc = join(mkdtempSync(join(tmpdir(), "acm-audit-restore-live-")), "doc.md");
    writeFileSync(restoreDoc, restoreSeed);
    await recordHistory(restoreDoc, "seed");
    restoreRef = (await listHistory(restoreDoc)).at(-1)?.split(/\s+/)[0] ?? "";
    if (!restoreRef) throw new Error("audit fixture: no history entry for the restore test");
  });

  test("#99 a symlinked spelling of a live document still routes through its server", async () => {
    const real = mkdtempSync(join(tmpdir(), "acm-audit-real-"));
    const alias = join(mkdtempSync(join(tmpdir(), "acm-audit-alias-")), "link");
    symlinkSync(real, alias);
    const seed = "Intro {==one==}{>>@luis: hmm<<} tail.\n";
    const b = await boot(seed, join(alias, "doc.md")); // the editor opened the alias path
    await Bun.sleep(200); // registerInstance is fire-and-forget
    // human cursor covers the whole doc → guard must refuse
    const r = await withPresence(b, 0, 10_000, () => cli(["reply", "hmm", "via real path", "--doc", join(real, "doc.md")]));
    expect({ code: r.code, disk: readFileSync(join(real, "doc.md"), "utf8") }).toEqual({ code: 1, disk: seed });
    expect(r.out).toContain("human's cursor"); // refused by the guard, not by a timeout
  }, CLI_TIMEOUT);

  test("#100 acm restore on a live document goes through the server (refused under the human's cursor)", async () => {
    const b = await boot(restoreSeed, restoreDoc);
    const ref = restoreRef;
    const edited = "Second version typed by the human.\n";
    expect((await put(b, { baseVersion: 0, content: edited })).status).toBe(200);
    await Bun.sleep(200);
    const r = await withPresence(b, 0, 10_000, () => cli(["restore", ref, "--doc", b.docPath]));
    expect({ code: r.code, disk: readFileSync(b.docPath, "utf8") }).toEqual({ code: 1, disk: edited });
    expect(r.out).toContain("human's cursor"); // refused by the guard, not by a timeout
  }, CLI_TIMEOUT);
});

describe("audit: CLI verbs", () => {
  test("#89 acm restore never passes a ref to git as an option (no truncation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-audit-restore-"));
    const doc = join(dir, "r.md");
    writeFileSync(doc, "Hello world, keep me.\nLine two.\n");
    await recordHistory(doc, "open");
    await cli(["restore", "--output=r.md", "--doc", doc], {}, dir);
    expect(readFileSync(doc, "utf8")).toBe("Hello world, keep me.\nLine two.\n");
  }, CLI_TIMEOUT);

  test("#102 `--doc=<file>` is honoured or refused, never ignored for another document", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-audit-flags-"));
    const seed = "Intro {==one==}{>>@luis: hmm<<} tail.\n";
    writeFileSync(join(dir, "named.md"), seed);
    writeFileSync(join(dir, "other.md"), seed);
    const r = await cli(["reply", "hmm", "hello", `--doc=${join(dir, "named.md")}`], { ACM_DOC: join(dir, "other.md") });
    expect(readFileSync(join(dir, "other.md"), "utf8")).toBe(seed);
    expect(r.code !== 0 || readFileSync(join(dir, "named.md"), "utf8") !== seed).toBe(true);
  }, CLI_TIMEOUT);

  test("#103 `acm reply --batch` exits non-zero when an item fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-audit-batch-"));
    const doc = join(dir, "b.md");
    writeFileSync(doc, "Intro {==one==}{>>@luis: hmm<<} tail.\n");
    writeFileSync(join(dir, "e.json"), JSON.stringify([
      { id: "a", match: "hmm", insert: "{>>@claude: ok<<}" },
      { id: "b", match: "NOPE", insert: "{>>@claude: ok2<<}" },
    ]));
    expect((await cli(["reply", "--batch", join(dir, "e.json"), "--doc", doc])).code).not.toBe(0);
  }, CLI_TIMEOUT);

  test("#106 acm wrap keeps a CRLF document's line endings CRLF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-audit-wrap-"));
    const doc = join(dir, "w.md");
    writeFileSync(doc, "Intro line.\r\n\r\nThe quick brown fox jumps over the lazy dog again and again and again forever.\r\n");
    await cli(["wrap", "40", "--doc", doc]);
    const out = readFileSync(doc, "utf8");
    expect(out.replaceAll("\r\n", "").includes("\n")).toBe(false);
  }, CLI_TIMEOUT);
});
