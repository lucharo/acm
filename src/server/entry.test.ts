import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `bun run start` / `just prod` boot server.ts directly from env (#33).
const serverEntry = resolve(import.meta.dir, "../../server.ts");
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

async function runEntry(env: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "acm-entry-"));
  scratch.push(dir);
  const { ACM_DOC: _drop, ...base } = process.env;
  const proc = Bun.spawn([process.execPath, serverEntry], {
    cwd: dir,
    // ACM_ALLOWED_HOSTS="" skips Tailscale discovery, which can stall startup.
    env: { ...base, XDG_CONFIG_HOME: join(dir, ".config"), ACM_PORT: "0", ACM_ALLOWED_HOSTS: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await Promise.race([
    proc.exited.then((code) => ({ timedOut: false, code })),
    Bun.sleep(1500).then(() => ({ timedOut: true, code: null as number | null })),
  ]);
  if (exit.timedOut) {
    proc.kill();
    await proc.exited;
  }
  return {
    ...exit,
    dir,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

describe("server.ts direct entry — no silent seed fallback (#33)", () => {
  test("no ACM_DOC refuses to start instead of serving the repo seed", async () => {
    const run = await runEntry({});

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("no document");
    expect(run.stdout).not.toContain("sample");
  });

  test("an explicit ACM_DOC starts and prints the resolved absolute path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-entry-doc-"));
    scratch.push(dir);
    const doc = join(dir, "notes.md");
    writeFileSync(doc, "# Notes\n");

    const run = await runEntry({ ACM_DOC: doc });

    expect(run.timedOut).toBe(true); // still serving when we stop it
    expect(run.stdout).toContain(`editing: ${doc}`);
  });
});
