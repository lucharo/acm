import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../../cli.ts");
// runBriefly caps a hung CLI at 15 s, so each test needs more than the 5 s default.
setDefaultTimeout(20_000);
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/** Run the CLI until it exits or prints `readyMarker`, whichever comes first. The cap
 *  only bounds a hang: a slow start on a loaded machine must not read as "stayed open". */
async function runBriefly(args: string[], configHomeIsFile = false, readyMarker = "ACM ready") {
  const cwd = mkdtempSync(join(tmpdir(), "acm-cli-contract-"));
  scratch.push(cwd);
  const configHome = join(cwd, ".config");
  if (configHomeIsFile) writeFileSync(configHome, "blocked\n");
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    // ACM_ALLOWED_HOSTS="" skips Tailscale discovery at startup.
    env: { ...process.env, XDG_CONFIG_HOME: configHome, ACM_ALLOWED_HOSTS: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "";
  const ready = (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
      if (stdout.includes(readyMarker)) {
        reader.releaseLock();
        return { stillRunning: true, code: null };
      }
    }
    return { stillRunning: false, code: await proc.exited };
  })();
  const exit = await Promise.race([
    ready,
    proc.exited.then((code) => ({ stillRunning: false, code })),
    Bun.sleep(15_000).then(() => ({ stillRunning: true, code: null })),
  ]);
  if (exit.stillRunning) {
    proc.kill();
    await proc.exited;
  }
  await ready.catch(() => undefined);
  return { ...exit, cwd, stdout, stderr: await new Response(proc.stderr).text() };
}

describe("explicit edit command", () => {
  test("options without `edit` do not create or launch an untitled document", async () => {
    const run = await runBriefly(["--no-open", "--port", "0"]);

    expect(run.stillRunning).toBe(false);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("acm edit");
    expect(existsSync(join(run.cwd, "untitled.md"))).toBe(false);
  });

  test("a bare filename is rejected rather than treated as a compatibility alias", async () => {
    const run = await runBriefly(["essay.md", "--no-open", "--port", "0"]);

    expect(run.stillRunning).toBe(false);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("acm edit essay.md");
    expect(existsSync(join(run.cwd, "essay.md"))).toBe(false);
  });

  test("direct editing stays open when optional recent-document storage is unwritable", async () => {
    const run = await runBriefly(
      ["edit", "essay.md", "--no-open", "--port", "0"],
      true,
    );

    expect(run.stillRunning).toBe(true);
    expect(run.stdout).toContain("ACM ready");
    expect(run.stderr).toContain("could not update Recent Documents");
    expect(existsSync(join(run.cwd, "essay.md"))).toBe(true);
  });
});
