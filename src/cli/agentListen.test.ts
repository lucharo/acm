// `acm edit <file.md> --notify | --wait` (#31), run as the real CLI: stdout carries
// only wake lines (an agent's line-watcher wakes on each), it attaches to an editor
// already open on the document, and --wait leaves the editor running when it exits.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer, type AcmServer } from "../../server";
import { liveInstances } from "../server/instances";

const cli = resolve(import.meta.dir, "../../cli.ts");
setDefaultTimeout(30_000);
const DOC = "# Title\n\nThe conference hall was beaming full of people. It was loud.\n";
const scratch: string[] = [];
const servers: AcmServer[] = [];
const procs: { kill(): void }[] = [];
const pids: number[] = [];

const previousConfigHome = process.env.XDG_CONFIG_HOME;
afterAll(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});

afterEach(() => {
  while (procs.length) procs.pop()!.kill();
  while (servers.length) servers.pop()!.stop();
  while (pids.length) {
    try {
      process.kill(pids.pop()!);
    } catch {
      // already gone
    }
  }
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function workspace(notifyEachComment = false) {
  const home = mkdtempSync(join(tmpdir(), "acm-listen-"));
  scratch.push(home);
  const configHome = join(home, ".config");
  mkdirSync(join(configHome, "acm"), { recursive: true });
  writeFileSync(join(configHome, "acm", "settings.json"), JSON.stringify({ settings: { author: "Luis", notifyEachComment } }));
  const docPath = join(home, "doc.md");
  writeFileSync(docPath, DOC);
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", XDG_CONFIG_HOME: configHome, ACM_ALLOWED_HOSTS: "" };
  return { home, configHome, docPath, env };
}

/** Spawn the CLI; read stdout and stderr as they arrive, bounded waits only. */
function run(args: string[], env: Record<string, string | undefined>, cwd: string) {
  const proc = Bun.spawn([process.execPath, cli, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  procs.push(proc);
  const out = { stdout: "", stderr: "" };
  const pump = async (stream: ReadableStream<Uint8Array>, key: "stdout" | "stderr") => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      out[key] += decoder.decode(value, { stream: true });
    }
  };
  void pump(proc.stdout, "stdout");
  void pump(proc.stderr, "stderr");
  const until = async (key: "stdout" | "stderr", pattern: RegExp, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!pattern.test(out[key])) {
      if (Date.now() > deadline) throw new Error(`no ${pattern} in ${key}: ${JSON.stringify(out)}`);
      await Bun.sleep(50);
    }
    return out[key].match(pattern)!;
  };
  return { proc, out, until };
}

const post = (port: number | string, path: string, body: Record<string, unknown>) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("acm edit --notify", () => {
  test("starts the editor and prints one stdout line per wake, nothing else", async () => {
    const ws = workspace(true);
    const acm = run(["edit", ws.docPath, "--notify", "--no-open", "--port", "0"], ws.env, ws.home);
    const [, port] = await acm.until("stderr", /ACM ready → http:\/\/localhost:(\d+)/);

    await post(port, "/api/comment", { documentPath: ws.docPath, author: "Luis", text: "Too wordy?", anchor: "conference hall" });
    await acm.until("stdout", /\n/);

    expect(acm.out.stdout).toMatch(/^acm: comment #\S+ Luis "conference hall"\n$/);
  });

  test("attaches to an editor already open on the document instead of starting another", async () => {
    const ws = workspace();
    process.env.XDG_CONFIG_HOME = ws.configHome; // the editor registers where the CLI looks
    const editor = startServer({ docPath: ws.docPath, port: 0, staticDir: "./dist" });
    servers.push(editor);
    await Bun.sleep(200); // registration is fire-and-forget

    const acm = run(["edit", ws.docPath, "--notify", "--no-open"], ws.env, ws.home);
    await acm.until("stderr", new RegExp(`listening to the editor at http://localhost:${editor.port}`));
    await post(editor.port, "/api/comment", { documentPath: ws.docPath, author: "Luis", text: "Too wordy?", anchor: "conference hall" });
    await post(editor.port, "/api/agent/wake", { documentPath: ws.docPath });
    await acm.until("stdout", /\n/);
    expect(acm.out.stdout).toBe("acm: review 1 thread waiting (1 comment, 0 edit requests) - run acm threads\n");

    editor.stop();
    servers.pop();
    await acm.until("stdout", /acm: closed /);
    expect(await acm.proc.exited).toBe(1);
  });
});

describe("acm edit --wait", () => {
  test("exits at once with the pending work when some was already sent", async () => {
    const ws = workspace();
    process.env.XDG_CONFIG_HOME = ws.configHome;
    const editor = startServer({ docPath: ws.docPath, port: 0, staticDir: "./dist" });
    servers.push(editor);
    await post(editor.port, "/api/comment", { documentPath: ws.docPath, author: "Luis", text: "Too wordy?", anchor: "conference hall" });
    await post(editor.port, "/api/agent/wake", { documentPath: ws.docPath });
    await Bun.sleep(200);

    const acm = run(["edit", ws.docPath, "--wait", "--no-open"], ws.env, ws.home);

    expect(await acm.proc.exited).toBe(0);
    expect(acm.out.stdout).toMatch(/^acm: pending #\S+ Luis "conference hall"\n$/);
  });

  test("with no editor open, starts one that outlives the wait", async () => {
    const ws = workspace();
    process.env.XDG_CONFIG_HOME = ws.configHome;
    const acm = run(["edit", ws.docPath, "--wait", "--no-open", "--port", "0"], ws.env, ws.home);
    const [, port] = await acm.until("stderr", /listening to the editor at http:\/\/localhost:(\d+)/);
    const [editor] = (await liveInstances()).filter((e) => realpathSync(e.doc) === realpathSync(ws.docPath));
    expect(editor?.port).toBe(Number(port));
    pids.push(editor!.pid);

    await post(port, "/api/comment", { documentPath: ws.docPath, author: "Luis", text: "Too wordy?", anchor: "conference hall" });
    await post(port, "/api/agent/wake", { documentPath: ws.docPath });

    expect(await acm.proc.exited).toBe(0);
    expect(acm.out.stdout).toBe("acm: review 1 thread waiting (1 comment, 0 edit requests) - run acm threads\n");
    expect((await fetch(`http://127.0.0.1:${port}/api/agent`)).status).toBe(200); // the editor is still up
  });
});
