import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserConfig } from "vite";
import { startServer, type AcmServer } from "../../server";
import viteConfigDefinition from "../../vite.config";
import { scanTokens } from "../lib/criticmarkup";
import { isAllowedHost, isAllowedOrigin, parseAllowedHosts, resolveAllowedHosts } from "./http";
import { startLauncherServer } from "./launcher";
import type { CommentToken } from "../lib/types";

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
  test("the dev proxy preserves the browser origin while targeting the IPv4-only backend", () => {
    const viteConfig = viteConfigDefinition as UserConfig;
    expect(viteConfig.server?.strictPort).toBe(true); // a restarted Vite keeps its URL (#34)
    expect(viteConfig.server?.proxy).toMatchObject({
      "/api": { target: "http://127.0.0.1:12000", changeOrigin: false },
      "/ws": { target: "ws://127.0.0.1:12000", changeOrigin: false },
    });
  });

  test("a same-origin request forwarded from the dev proxy can modify the document", async () => {
    const docPath = join(mkdtempSync(join(tmpdir(), "acm-security-doc-")), "doc.md");
    await Bun.write(docPath, "Original.\n");
    const acm = startServer({ docPath, port: 0, staticDir: "./dist" });
    live.push(acm);
    const response = await fetch(`http://127.0.0.1:${acm.server.port}/api/comment`, {
      method: "POST",
      headers: {
        Host: "localhost:12173",
        Origin: "http://localhost:12173",
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({
        anchor: 0,
        text: "proxied write",
        author: "editor",
        documentPath: docPath,
      }),
    });

    expect(response.status).toBe(200);
    expect(await Bun.file(docPath).text()).toBe("{>>@editor: proxied write<<}Original.\n");
  });

  test("the comment API serializes pasted blank lines and reloads the exact body", async () => {
    const docPath = join(mkdtempSync(join(tmpdir(), "acm-security-doc-")), "doc.md");
    await Bun.write(docPath, "Original.\n");
    const acm = startServer({ docPath, port: 0, staticDir: "./dist" });
    live.push(acm);
    const body = "first line\n\nsecond line";

    const response = await fetch(`http://127.0.0.1:${acm.server.port}/api/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchor: 0, text: body, author: "editor", documentPath: docPath }),
    });

    expect(response.status).toBe(200);
    const reloaded = await Bun.file(docPath).text();
    expect(reloaded).toBe("{>>@editor: ~acm1~first line\\n\\nsecond line<<}Original.\n");
    expect(
      scanTokens(reloaded).filter((token): token is CommentToken => token.type === "comment"),
    ).toEqual([expect.objectContaining({ author: "editor", body })]);
  });

  test("the comment API rejects a missing document identity before writing", async () => {
    const docPath = join(mkdtempSync(join(tmpdir(), "acm-security-doc-")), "doc.md");
    await Bun.write(docPath, "Original.\n");
    const acm = startServer({ docPath, port: 0, staticDir: "./dist" });
    live.push(acm);

    const response = await fetch(`http://127.0.0.1:${acm.server.port}/api/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchor: 0, text: "unbound write", author: "editor" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      audit: {
        status: "failed",
        code: "document-mismatch",
        retryable: false,
      },
    });
    expect(await Bun.file(docPath).text()).toBe("Original.\n");
  });

  test("the comment API rejects another document identity before writing", async () => {
    const docPath = join(mkdtempSync(join(tmpdir(), "acm-security-doc-")), "doc.md");
    await Bun.write(docPath, "Original.\n");
    const acm = startServer({ docPath, port: 0, staticDir: "./dist" });
    live.push(acm);

    const response = await fetch(`http://127.0.0.1:${acm.server.port}/api/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anchor: 0,
        text: "wrong document",
        author: "editor",
        documentPath: `${docPath}.other`,
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      audit: {
        status: "failed",
        code: "document-mismatch",
        retryable: false,
      },
    });
    expect(await Bun.file(docPath).text()).toBe("Original.\n");
  });

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

describe("a trusted remote host (#73)", () => {
  const TS = "mac.tailnet.ts.net";
  const allowed = new Set([TS]);
  const req = (headers: Record<string, string>) => new Request("http://127.0.0.1/api/doc", { headers });

  async function commentAs(port: number, docPath: string, headers: Record<string, string>) {
    return fetch(`http://127.0.0.1:${port}/api/comment`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: JSON.stringify({ anchor: 0, text: "remote note", author: "luis", documentPath: docPath }),
    });
  }

  test("an allowed host on any port passes the Host check; others still fail", () => {
    expect(isAllowedHost(`${TS}:10464`, allowed)).toBe(true);
    expect(isAllowedHost(TS, allowed)).toBe(true);
    expect(isAllowedHost("MAC.TAILNET.TS.NET", allowed)).toBe(true);
    expect(isAllowedHost("localhost:12000", allowed)).toBe(true);
    expect(isAllowedHost("attacker.example", allowed)).toBe(false);
    expect(isAllowedHost(`${TS}.attacker.example`, allowed)).toBe(false);
    expect(isAllowedHost(`${TS}:10464`, new Set())).toBe(false);
  });

  test("same-origin accepts https only for an allowed host", () => {
    expect(isAllowedOrigin(req({ host: `${TS}:10464`, origin: `https://${TS}:10464` }), allowed)).toBe(true);
    expect(isAllowedOrigin(req({ host: TS, origin: `https://${TS}` }), allowed)).toBe(true);
    expect(isAllowedOrigin(req({ host: "localhost:5", origin: "https://localhost:5" }), allowed)).toBe(false);
    expect(isAllowedOrigin(req({ host: `${TS}:10464`, origin: `https://evil.example` }), allowed)).toBe(false);
    expect(isAllowedOrigin(req({ host: `${TS}:10464`, origin: `https://${TS}:10464` }), new Set())).toBe(false);
  });

  test("ACM_ALLOWED_HOSTS / --allow-host values parse to bare lowercase host names", () => {
    expect(parseAllowedHosts(["Mac.Tailnet.ts.net.", "other.example, third.example"])).toEqual([
      "mac.tailnet.ts.net",
      "other.example",
      "third.example",
    ]);
  });

  test("explicit hosts win; with none given, the Tailscale name when Tailscale is up", () => {
    const detect = () => TS;
    expect(resolveAllowedHosts({ flags: ["a.example"], env: "b.example", detect })).toEqual(["a.example"]);
    expect(resolveAllowedHosts({ flags: [], env: "b.example", detect })).toEqual(["b.example"]);
    expect(resolveAllowedHosts({ flags: [], env: "", detect })).toEqual([]); // set but empty = opt out
    expect(resolveAllowedHosts({ flags: [], env: undefined, detect })).toEqual([TS]);
    expect(resolveAllowedHosts({ flags: [], env: undefined, detect: () => null })).toEqual([]);
  });

  test("the document server accepts a write through the allowed host and refuses others", async () => {
    const docPath = join(mkdtempSync(join(tmpdir(), "acm-security-doc-")), "doc.md");
    await Bun.write(docPath, "Original.\n");
    const acm = startServer({ docPath, port: 0, staticDir: "./dist", allowedHosts: [TS] });
    live.push(acm);

    const remote = await commentAs(acm.port, docPath, { Host: `${TS}:10464`, Origin: `https://${TS}:10464` });
    const rebound = await commentAs(acm.port, docPath, { Host: "attacker.example", Origin: "https://attacker.example" });

    expect([remote.status, rebound.status]).toEqual([200, 403]);
    expect(await Bun.file(docPath).text()).toBe("{>>@luis: remote note<<}Original.\n");
  });

  test("the launcher stays loopback-only: its document switch changes port, which a tunnel can't follow", async () => {
    const launcher = startLauncherServer({
      port: 0,
      cwd: mkdtempSync(join(tmpdir(), "acm-security-launcher-")),
      staticDir: "./dist",
      activateDocument: async () => ({ url: "" }),
    });
    try {
      const local = await fetch(`http://127.0.0.1:${launcher.port}/api/session`, { headers: { Host: "localhost" } });
      const remote = await fetch(`http://127.0.0.1:${launcher.port}/api/session`, { headers: { Host: TS } });
      expect([local.status, remote.status]).toEqual([200, 403]);
    } finally {
      launcher.stop();
    }
  });
});

