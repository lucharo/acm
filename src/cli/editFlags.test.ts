import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `acm edit` flags reach the server it starts: --asset-root (#64) lets a doc
// outside any git repo show a parent-relative image; --allow-host (#73) admits a
// remote Host such as a Tailscale name.

const cli = resolve(import.meta.dir, "../../cli.ts");
const scratch: string[] = [];
const procs: { kill(): void; exited: Promise<number> }[] = [];

afterEach(async () => {
  while (procs.length) {
    const p = procs.pop()!;
    p.kill();
    await p.exited;
  }
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

async function startEdit(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const { ACM_ASSET_ROOT: _drop, ...base } = process.env;
  const proc = Bun.spawn([process.execPath, cli, "edit", ...args, "--no-open", "--port", "0"], {
    cwd,
    env: { ...base, XDG_CONFIG_HOME: join(cwd, ".config"), ACM_ALLOWED_HOSTS: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  let out = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
    const url = /ACM ready → (http:\/\/localhost:\d+)/.exec(out)?.[1];
    if (url) return url.replace("localhost", "127.0.0.1");
  }
  throw new Error(`acm edit never became ready:\n${out}`);
}

describe("acm edit flags reach the server", () => {
  test("serves a parent-relative image from the named root, and not without it", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "acm-edit-root-")));
    scratch.push(base);
    mkdirSync(join(base, "notes", "drafts"), { recursive: true });
    mkdirSync(join(base, "figures"));
    writeFileSync(join(base, "figures", "plot.png"), "plot");
    writeFileSync(join(base, "notes", "drafts", "doc.md"), "# Doc\n");
    const asset = `/api/asset?path=${encodeURIComponent("../../figures/plot.png")}`;

    const rooted = await startEdit(base, ["notes/drafts/doc.md", "--asset-root", "."]);
    const viaEnv = await startEdit(base, ["notes/drafts/doc.md"], { ACM_ASSET_ROOT: base });
    const plain = await startEdit(base, ["notes/drafts/doc.md"]);

    expect((await fetch(rooted + asset)).status).toBe(200);
    expect((await fetch(viaEnv + asset)).status).toBe(200);
    expect((await fetch(plain + asset)).status).toBe(403);
  });

  test("--allow-host admits that Host; without it the same request is refused", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "acm-edit-host-")));
    scratch.push(base);
    writeFileSync(join(base, "doc.md"), "# Doc\n");
    const headers = { Host: "mac.tailnet.ts.net:10464" };

    const allowed = await startEdit(base, ["doc.md", "--allow-host", "mac.tailnet.ts.net"]);
    const plain = await startEdit(base, ["doc.md"]);

    expect((await fetch(`${allowed}/api/doc`, { headers })).status).toBe(200);
    expect((await fetch(`${plain}/api/doc`, { headers })).status).toBe(403);
  });
});
