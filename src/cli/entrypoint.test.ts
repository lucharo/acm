import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
async function runBriefly(
  args: string[],
  configHomeIsFile = false,
  readyMarker = "ACM ready",
  arrange: (home: string) => void = () => undefined,
) {
  const cwd = mkdtempSync(join(tmpdir(), "acm-cli-contract-"));
  scratch.push(cwd);
  arrange(cwd);
  const configHome = join(cwd, ".config");
  if (configHomeIsFile) writeFileSync(configHome, "blocked\n");
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    // ACM_ALLOWED_HOSTS="" skips Tailscale discovery at startup.
    env: { ...process.env, HOME: cwd, CLAUDE_CONFIG_DIR: "", XDG_CONFIG_HOME: configHome, ACM_ALLOWED_HOSTS: "" },
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

describe("acm --version (#55)", () => {
  test("prints the package version and where it came from, and starts nothing", async () => {
    const { version } = await Bun.file(resolve(import.meta.dir, "../../package.json")).json();
    const run = await runBriefly(["--version"]);

    // From source the build is this checkout; the line names it after the version.
    expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
    expect(run.stdout).toMatch(new RegExp(`^acm ${version.replaceAll(".", "\\.")} \\(local checkout[^\\n]*\\)\\n$`));
  });
});

describe("explicit edit command", () => {
  test("options without `edit` do not create or launch an untitled document", async () => {
    const run = await runBriefly(["--no-open", "--port", "0"]);

    expect(run.stillRunning).toBe(false);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("acm edit");
    expect(existsSync(join(run.cwd, "untitled.md"))).toBe(false);
  });

  test("acm skill opens the user's preferences skill when it exists", async () => {
    const result = await runBriefly(["skill", "--no-open", "--port", "0"], false, "ACM ready", (home) => {
      const folder = join(home, ".agents", "skills", "acm-user-preferences");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "SKILL.md"), "Never suggest em dashes.\n");
    });

    expect(result.stillRunning).toBe(true);
    expect(result.stdout).toContain(join(".agents", "skills", "acm-user-preferences", "SKILL.md"));
  });

  test("acm skill says how to start when there is no skill yet, and starts nothing", async () => {
    const result = await runBriefly(["skill", "--no-open", "--port", "0"]);

    expect(result.stillRunning).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No review preferences yet.");
    expect(existsSync(join(result.cwd, ".agents"))).toBe(false);
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
