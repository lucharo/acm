import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer, type AcmServer } from "../../server";
import { documentUpdateLockPath, withFileUpdateLock } from "./fileLock";

// Write-path fixes from the 2026-11 editing-API audit: #90 (bad bodies), #92
// (UTF-8 BOM documents), #98 (cursor guard with a stale agent base).

const CLI = resolve(import.meta.dir, "../../cli.ts");
const J = { "content-type": "application/json" };
const BOM = "\uFEFF";
const live: AcmServer[] = [];
let previousConfigHome: string | undefined;

beforeAll(() => {
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "acm-writepaths-xdg-"));
});
afterAll(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});
afterEach(() => {
  while (live.length) live.pop()!.stop();
});

async function boot(seed: string) {
  const docPath = join(mkdtempSync(join(tmpdir(), "acm-writepaths-doc-")), "doc.md");
  await Bun.write(docPath, seed);
  const srv = startServer({ docPath, port: 0, staticDir: "./dist" });
  live.push(srv);
  const url = `http://127.0.0.1:${srv.port}`;
  const snap = (await (await fetch(`${url}/api/doc`)).json()) as { path: string; serverEpoch: string; version: number; content: string };
  return { url, docPath, path: snap.path, epoch: snap.serverEpoch, version: snap.version, content: snap.content };
}
type Booted = Awaited<ReturnType<typeof boot>>;

const send = (b: Booted, method: string, route: string, body: Record<string, unknown>) =>
  fetch(`${b.url}${route}`, { method, headers: J, body: JSON.stringify({ documentPath: b.path, ...body }) });
const put = (b: Booted, body: Record<string, unknown>) => send(b, "PUT", "/api/doc", { serverEpoch: b.epoch, ...body });
const bytes = (path: string) => readFileSync(path);

describe("#90 write routes refuse wrongly typed fields with 400 and never write", () => {
  const seed = "Para one.\n\nPara two.\n";

  test("PUT /api/doc: non-string or missing content, non-integer baseVersion", async () => {
    const b = await boot(seed);
    const statuses = [];
    for (const body of [{ baseVersion: 0, content: 42 }, { baseVersion: 0, content: { a: 1 } }, { baseVersion: 0 }, { baseVersion: "0", content: "x" }]) {
      statuses.push((await put(b, body)).status);
    }
    expect({ statuses, disk: readFileSync(b.docPath, "utf8") }).toEqual({ statuses: [400, 400, 400, 400], disk: seed });
  });

  test("POST /api/agent-write: missing base or content, non-string content", async () => {
    const b = await boot(seed);
    const statuses = [];
    for (const body of [{ content: "X\n" }, { base: seed }, { base: seed, content: 7 }]) {
      statuses.push((await send(b, "POST", "/api/agent-write", body)).status);
    }
    expect({ statuses, disk: readFileSync(b.docPath, "utf8") }).toEqual({ statuses: [400, 400, 400], disk: seed });
  });

  test("POST /api/comment: a non-string author", async () => {
    const b = await boot(seed);
    const r = await send(b, "POST", "/api/comment", { anchor: 3, text: "hi", author: 5 });
    expect({ status: r.status, disk: readFileSync(b.docPath, "utf8") }).toEqual({ status: 400, disk: seed });
  });

  test("POST /api/comment: an omitted author defaults instead of failing", async () => {
    const b = await boot(seed);
    const point = await send(b, "POST", "/api/comment", { anchor: 0, text: "hi" });
    const span = await send(b, "POST", "/api/comment", { anchor: "Para two", text: "there" });
    expect([point.status, span.status]).toEqual([200, 200]);
    expect(readFileSync(b.docPath, "utf8")).toContain("@You: hi");
  });

  test("PUT /api/presence: non-numeric offsets", async () => {
    const b = await boot(seed);
    expect((await send(b, "PUT", "/api/presence", { from: "a", to: 3 })).status).toBe(400);
  });
});

describe("#92 a document starting with a UTF-8 BOM behaves like any other", () => {
  const seed = `${BOM}# Title\n\nPara one.\n`;

  test("an edit to the first line saves, and the BOM stays on disk", async () => {
    const b = await boot(seed);
    const r = await put(b, { baseVersion: b.version, content: b.content.replace("# Title", "# Title EDITED") });

    expect(r.status).toBe(200);
    expect(readFileSync(b.docPath, "utf8")).toBe(`${BOM}# Title EDITED\n\nPara one.\n`);
  });

  test("the editor never sees the BOM", async () => {
    const b = await boot(seed);
    expect(b.content).toBe("# Title\n\nPara one.\n");
  });

  test("content sent with a leading BOM is refused (memory never holds one), and nothing is written", async () => {
    const b = await boot(seed);
    const human = await put(b, { baseVersion: b.version, content: `${BOM}# Title v2\n\nPara one.\n` });
    const agent = await send(b, "POST", "/api/agent-write", { base: `${BOM}# Title\n\nPara one.\n`, content: `${BOM}# T\n\nPara one.\n` });

    expect({ human: human.status, agent: agent.status, disk: readFileSync(b.docPath, "utf8") }).toEqual({
      human: 400,
      agent: 400,
      disk: seed,
    });
  });

  test("acm restore of a version saved with a BOM succeeds and keeps the BOM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-writepaths-restore-"));
    const doc = join(dir, "doc.md");
    await Bun.write(doc, `${BOM}# Old\n`);
    const env = { ...process.env, XDG_CONFIG_HOME: join(dir, ".config"), ACM_DOC: undefined };
    const { recordHistory, listHistory } = await import("./history");
    await recordHistory(doc, "seed");
    await Bun.write(doc, `${BOM}# New\n`);
    const ref = (await listHistory(doc)).at(-1)!.split(/\s+/)[0];

    const p = Bun.spawnSync([process.execPath, CLI, "restore", ref, "--doc", doc], { env });

    expect({ code: p.exitCode, disk: readFileSync(doc, "utf8") }).toEqual({ code: 0, disk: `${BOM}# Old\n` });
  });

  test("a CLI verb on a document that does not exist fails instead of reading it as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-writepaths-missing-"));
    const p = Bun.spawnSync([process.execPath, CLI, "threads", "--doc", join(dir, "typo.md")], {
      env: { ...process.env, XDG_CONFIG_HOME: join(dir, ".config"), ACM_DOC: undefined },
    });
    expect(p.exitCode).not.toBe(0);
  });

  test("a CLI verb keeps the BOM and its snapshot is byte-exact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-writepaths-cli-"));
    const doc = join(dir, "doc.md");
    const original = `${BOM}Intro {==one==}{>>@luis: hmm<<} tail.\n`;
    await Bun.write(doc, original);
    const p = Bun.spawnSync([process.execPath, CLI, "reply", "hmm", "noted", "--doc", doc, "--author", "claude"], {
      env: { ...process.env, XDG_CONFIG_HOME: join(dir, ".config"), ACM_DOC: undefined },
    });
    expect(p.exitCode).toBe(0);

    const after = readFileSync(doc, "utf8");
    const snapDir = join(dir, ".acm", "snapshots", "doc.md");
    const snap = readdirSync(snapDir).find((f) => f.endsWith(".md"))!;
    expect(after.startsWith(`${BOM}Intro`)).toBe(true);
    expect(after).toContain("noted");
    expect(bytes(join(snapDir, snap)).equals(Buffer.from(original))).toBe(true);
  });
});

describe("#98 the cursor guard compares the agent's change in current-document offsets", () => {
  const seed = "Intro.\n\nTarget sentence here.\n";
  const card = seed.replace("Target sentence here.", "{==Target==}{>>@claude: SUGGEST: Goal<<} sentence here.");
  const human = "A".repeat(300) + "\n\n" + seed; // the human saved 300 As above, after the agent read

  test("a stale-base card on the human's caret is refused", async () => {
    const b = await boot(seed);
    expect((await put(b, { baseVersion: 0, content: human })).status).toBe(200);
    const at = human.indexOf("Target");
    await send(b, "PUT", "/api/presence", { from: at, to: at + 6 });

    const r = await send(b, "POST", "/api/agent-write", { base: seed, content: card });

    expect({ status: r.status, disk: readFileSync(b.docPath, "utf8") }).toEqual({ status: 409, disk: human });
  });

  test("#115 a caret that moves onto the target while the write waits for the file lock is honoured", async () => {
    const b = await boot(seed);
    const at = seed.indexOf("Target");
    let pending: Promise<Response> | undefined;
    await withFileUpdateLock(documentUpdateLockPath(b.docPath), "test holder", async () => {
      await send(b, "PUT", "/api/presence", { from: 0, to: 0 }); // caret away from the target
      pending = send(b, "POST", "/api/agent-write", { base: seed, content: card });
      await Bun.sleep(150); // the write is now queued behind this lock
      await send(b, "PUT", "/api/presence", { from: at, to: at + 6 }); // caret moves onto it
    });

    const r = await pending!;

    expect({ status: r.status, body: await r.json(), disk: readFileSync(b.docPath, "utf8") }).toEqual({
      status: 409,
      body: { conflict: "cursor" },
      disk: seed,
    });
  });

  test("retrying an edit that already landed succeeds, even with the caret at the end", async () => {
    const b = await boot(seed);
    expect((await send(b, "POST", "/api/agent-write", { base: seed, content: card })).status).toBe(200);
    await send(b, "PUT", "/api/presence", { from: card.length, to: card.length });

    const retry = await send(b, "POST", "/api/agent-write", { base: seed, content: card });

    expect({ status: retry.status, disk: readFileSync(b.docPath, "utf8") }).toEqual({ status: 200, disk: card });
  });

  test("a stale-base card away from the caret lands, even where the caret's offset was in the base", async () => {
    const b = await boot(seed);
    expect((await put(b, { baseVersion: 0, content: human })).status).toBe(200);
    const at = seed.indexOf("Target"); // inside the As now: same number, different place
    await send(b, "PUT", "/api/presence", { from: at, to: at + 6 });

    const r = await send(b, "POST", "/api/agent-write", { base: seed, content: card });

    expect(r.status).toBe(200);
    expect(readFileSync(b.docPath, "utf8")).toBe("A".repeat(300) + "\n\n" + card);
  });
});
