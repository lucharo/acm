import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecentDocuments, recordRecentDocument } from "./recent";

const previousXdg = process.env.XDG_CONFIG_HOME;
const scratch: string[] = [];

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function temp() {
  const path = mkdtempSync(join(tmpdir(), "acm-recent-"));
  scratch.push(path);
  return path;
}

describe("recent documents", () => {
  test("records, de-duplicates and sorts documents across cold reads", async () => {
    const root = temp();
    process.env.XDG_CONFIG_HOME = join(root, "config");
    const first = join(root, "first.md");
    const second = join(root, "second.md");
    writeFileSync(first, "first\n");
    writeFileSync(second, "second\n");

    await recordRecentDocument(first, "2026-08-06T10:00:00.000Z");
    await recordRecentDocument(second, "2026-08-06T11:00:00.000Z");
    await recordRecentDocument(first, "2026-08-06T12:00:00.000Z");

    expect(await listRecentDocuments()).toEqual([
      { path: first, name: "first.md", openedAt: "2026-08-06T12:00:00.000Z" },
      { path: second, name: "second.md", openedAt: "2026-08-06T11:00:00.000Z" },
    ]);
  });

  test("missing documents disappear from the launcher", async () => {
    const root = temp();
    process.env.XDG_CONFIG_HOME = join(root, "config");
    const missing = join(root, "gone.md");
    await recordRecentDocument(missing, "2026-08-06T12:00:00.000Z");

    expect(await listRecentDocuments()).toEqual([]);
  });

  test("an unwritable recent-document store is optional editor metadata", async () => {
    const root = temp();
    const blockedConfigHome = join(root, "not-a-directory");
    writeFileSync(blockedConfigHome, "blocked\n");
    process.env.XDG_CONFIG_HOME = blockedConfigHome;

    expect(await recordRecentDocument(join(root, "essay.md"))).toBe(false);
  });
});
