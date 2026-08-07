import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type AcmServer } from "../../server";

const live: AcmServer[] = [];
const scratch: string[] = [];

afterEach(() => {
  while (live.length) live.pop()!.stop();
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe("document server session", () => {
  test("identifies the one document owned by this server", async () => {
    const root = mkdtempSync(join(tmpdir(), "acm-document-session-"));
    scratch.push(root);
    const docPath = join(root, "essay.md");
    writeFileSync(docPath, "hello\n");
    const acm = startServer({ docPath, port: 0, staticDir: "./dist" });
    live.push(acm);

    const response = await fetch(`http://127.0.0.1:${acm.port}/api/session`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: "document", path: docPath });
  });
});
