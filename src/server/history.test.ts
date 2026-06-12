import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordHistory, listHistory, showVersion } from "./history";

const dir = mkdtempSync(join(tmpdir(), "acm-history-"));
const doc = join(dir, "essay.md");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("doc history (git shadow journal)", () => {
  test("records versions, skips no-ops, lists newest-first, restores byte-faithfully", async () => {
    const v1 = "# Essay\n\nFirst version with {>>@l: a note<<} here.\n";
    writeFileSync(doc, v1);
    const sha1 = await recordHistory(doc, "open");
    expect(sha1).not.toBeNull();

    // Unchanged content → no new journal entry.
    expect(await recordHistory(doc, "edit")).toBeNull();

    const v2 = "# Essay\n\nSecond version, the note resolved.\n";
    writeFileSync(doc, v2);
    const sha2 = await recordHistory(doc, "edit");
    expect(sha2).not.toBeNull();
    expect(sha2).not.toBe(sha1);

    const log = await listHistory(doc);
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("edit:");
    expect(log[1]).toContain("open: ");
    expect(log[1]).toContain("1 comments"); // word/comment tally in the message

    // Byte-faithful retrieval of the old version (trailing newline included).
    expect(await showVersion(doc, sha1!)).toBe(v1);
    expect(await showVersion(doc, "not-a-ref")).toBeNull();

    // The doc dir stays clean: journal lives under .acm/, no nested .git.
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(existsSync(join(dir, ".acm", "history.git"))).toBe(true);
  });
});
