import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Point the config home at a throwaway dir BEFORE importing the module under test
// (configHome() reads the env per call, so ordering is belt-and-braces).
const tmp = mkdtempSync(join(tmpdir(), "acm-instances-"));
const prevXdg = process.env.XDG_CONFIG_HOME;
beforeAll(() => {
  process.env.XDG_CONFIG_HOME = tmp;
});
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tmp, { recursive: true, force: true });
});

import { registerInstance, liveInstances } from "./instances";

describe("instance registry", () => {
  test("register + resolve; dead pids are filtered and pruned", async () => {
    await registerInstance(12000, "/tmp/live-doc.md");
    // Plant a convincing-but-dead entry alongside (pid that can't exist).
    const file = join(tmp, "acm", "instances.json");
    mkdirSync(join(tmp, "acm"), { recursive: true });
    const current = await Bun.file(file).json();
    current["12345"] = { port: 12345, doc: "/tmp/dead-doc.md", pid: 999999999, startedAt: "2026-01-01" };
    writeFileSync(file, JSON.stringify(current));

    const live = await liveInstances();
    expect(live).toHaveLength(1);
    expect(live[0].port).toBe(12000);
    expect(live[0].doc).toBe("/tmp/live-doc.md");
    expect(live[0].pid).toBe(process.pid);

    // Registering again prunes the dead entry from the file itself.
    await registerInstance(12001, "/tmp/second.md");
    const after = await Bun.file(file).json();
    expect(Object.keys(after).sort()).toEqual(["12000", "12001"]);
  });
});
