import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../../cli.ts");
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

async function runBriefly(args: string[], configHomeIsFile = false) {
  const cwd = mkdtempSync(join(tmpdir(), "acm-cli-contract-"));
  scratch.push(cwd);
  const configHome = join(cwd, ".config");
  if (configHomeIsFile) writeFileSync(configHome, "blocked\n");
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    // ACM_ALLOWED_HOSTS="" skips Tailscale discovery, which would eat this 800 ms budget.
    env: { ...process.env, XDG_CONFIG_HOME: configHome, ACM_ALLOWED_HOSTS: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await Promise.race([
    proc.exited.then((code) => ({ timedOut: false, code })),
    Bun.sleep(800).then(() => ({ timedOut: true, code: null })),
  ]);
  if (exit.timedOut) {
    proc.kill();
    await proc.exited;
  }
  return {
    ...exit,
    cwd,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

describe("explicit edit command", () => {
  test("options without `edit` do not create or launch an untitled document", async () => {
    const run = await runBriefly(["--no-open", "--port", "0"]);

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("acm edit");
    expect(existsSync(join(run.cwd, "untitled.md"))).toBe(false);
  });

  test("a bare filename is rejected rather than treated as a compatibility alias", async () => {
    const run = await runBriefly(["essay.md", "--no-open", "--port", "0"]);

    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("acm edit essay.md");
    expect(existsSync(join(run.cwd, "essay.md"))).toBe(false);
  });

  test("direct editing stays open when optional recent-document storage is unwritable", async () => {
    const run = await runBriefly(
      ["edit", "essay.md", "--no-open", "--port", "0"],
      true,
    );

    expect(run.timedOut).toBe(true);
    expect(run.stdout).toContain("ACM ready");
    expect(run.stderr).toContain("could not update Recent Documents");
    expect(existsSync(join(run.cwd, "essay.md"))).toBe(true);
  });
});
