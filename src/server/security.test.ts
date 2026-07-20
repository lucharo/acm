import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type AcmServer } from "../../server";

const live: AcmServer[] = [];
let previousConfigHome: string | undefined;

beforeAll(() => {
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "acm-security-xdg-"));
});

afterAll(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});

afterEach(() => {
  while (live.length) live.pop()!.stop();
});

describe("local server request boundary", () => {
  test("a cross-origin request with a non-loopback Host cannot modify the document", async () => {
    const docPath = join(mkdtempSync(join(tmpdir(), "acm-security-doc-")), "doc.md");
    await Bun.write(docPath, "Original.\n");
    const acm = startServer({ docPath, port: 0, staticDir: "./dist" });
    live.push(acm);
    const response = await fetch(`http://127.0.0.1:${acm.server.port}/api/comment`, {
      method: "POST",
      headers: {
        Host: "attacker.example",
        Origin: "https://evil.example",
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ anchor: 0, text: "drive-by write", author: "attacker" }),
    });

    expect(response.status).toBe(403);
    expect(await Bun.file(docPath).text()).toBe("Original.\n");
  });

  test("a hostile Origin cannot modify a loopback document", async () => {
    const docPath = join(mkdtempSync(join(tmpdir(), "acm-security-doc-")), "doc.md");
    await Bun.write(docPath, "Original.\n");
    const acm = startServer({ docPath, port: 0, staticDir: "./dist" });
    live.push(acm);
    const response = await fetch(`http://127.0.0.1:${acm.server.port}/api/comment`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ anchor: 0, text: "drive-by write", author: "attacker" }),
    });

    expect(response.status).toBe(403);
    expect(await Bun.file(docPath).text()).toBe("Original.\n");
  });
});
