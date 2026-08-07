import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readConfig, updateConfig } from "./config";

const previousXdg = process.env.XDG_CONFIG_HOME;
const scratch: string[] = [];

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function tempConfigHome() {
  const root = mkdtempSync(join(tmpdir(), "acm-config-lock-"));
  scratch.push(root);
  process.env.XDG_CONFIG_HOME = root;
}

describe("shared ACM config updates", () => {
  test("overlapping process-style read-modify-writes preserve both patches", async () => {
    tempConfigHome();
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = updateConfig<Record<string, unknown>>("settings.json", {}, async (current) => {
      enteredFirst();
      await firstMayFinish;
      return { ...current, first: true };
    });
    await firstEntered;
    const second = updateConfig<Record<string, unknown>>("settings.json", {}, (current) => ({
      ...current,
      second: true,
    }));
    await Bun.sleep(20);
    releaseFirst();

    await Promise.all([first, second]);

    expect(await readConfig("settings.json", {})).toEqual({
      first: true,
      second: true,
    });
  });
});
