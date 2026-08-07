import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLauncherServer, type AcmLauncherServer } from "./launcher";
import { readConfig, SETTINGS_FILE, writeConfig } from "./config";
import { recordRecentDocument } from "./recent";

const live: AcmLauncherServer[] = [];
const scratch: string[] = [];
let previousXdg: string | undefined;

beforeAll(() => {
  previousXdg = process.env.XDG_CONFIG_HOME;
});

afterAll(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
});

afterEach(() => {
  while (live.length) live.pop()!.stop();
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function temp() {
  const path = mkdtempSync(join(tmpdir(), "acm-launcher-"));
  scratch.push(path);
  process.env.XDG_CONFIG_HOME = join(path, ".config");
  return path;
}

function boot(cwd: string, opened: Array<{ path: string; created: boolean }> = []) {
  const launcher = startLauncherServer({
    cwd,
    port: 0,
    staticDir: "./dist",
    activateDocument: async (path, created) => {
      opened.push({ path, created });
      return { url: "http://localhost:54321" };
    },
  });
  live.push(launcher);
  return `http://127.0.0.1:${launcher.port}`;
}

describe("document launcher server", () => {
  test("cold session exposes the launch folder and existing recent documents", async () => {
    const cwd = temp();
    const recentPath = join(cwd, "recent.md");
    writeFileSync(recentPath, "recent\n");
    await recordRecentDocument(recentPath, "2026-08-06T12:00:00.000Z");
    const url = boot(cwd);

    const response = await fetch(`${url}/api/session`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "launcher",
      cwd,
      recent: [{ path: recentPath, name: "recent.md", openedAt: "2026-08-06T12:00:00.000Z" }],
    });
  });

  test("New creates only the confirmed path and activates it", async () => {
    const cwd = temp();
    const opened: Array<{ path: string; created: boolean }> = [];
    const url = boot(cwd, opened);

    const response = await fetch(`${url}/api/launcher/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "named.md", create: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "http://localhost:54321",
      path: join(cwd, "named.md"),
      created: true,
    });
    expect(await Bun.file(join(cwd, "named.md")).text()).toBe("");
    expect(opened).toEqual([{ path: join(cwd, "named.md"), created: true }]);
  });

  test("Open requires an existing file and creates nothing on failure", async () => {
    const cwd = temp();
    const opened: Array<{ path: string; created: boolean }> = [];
    const url = boot(cwd, opened);

    const response = await fetch(`${url}/api/launcher/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "missing.md", create: false }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Document not found. Use New to create it." });
    expect(await Bun.file(join(cwd, "missing.md")).exists()).toBe(false);
    expect(opened).toEqual([]);
  });

  test("serves and updates the same global settings used by document editors", async () => {
    const cwd = temp();
    await writeConfig(SETTINGS_FILE, {
      settings: { theme: "dark" },
      seenByDocument: { "/docs/first.md": ["keep"] },
    });
    const url = boot(cwd);

    expect(await (await fetch(`${url}/api/settings`)).json()).toEqual({
      settings: { theme: "dark" },
      seenByDocument: { "/docs/first.md": ["keep"] },
    });

    const response = await fetch(`${url}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        settings: { theme: "light" },
        seenByDocument: { "/docs/second.md": ["second"] },
      }),
    });

    expect(response.status).toBe(200);
    expect(await readConfig(SETTINGS_FILE, {})).toEqual({
      settings: { theme: "light" },
      seenByDocument: {
        "/docs/first.md": ["keep"],
        "/docs/second.md": ["second"],
      },
    });
  });

  test("separate ACM processes preserve concurrent per-document settings patches", async () => {
    const cwd = temp();
    const first = boot(cwd);
    const second = boot(cwd);

    const responses = await Promise.all([
      fetch(`${first}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seenByDocument: { "/docs/first.md": ["first"] } }),
      }),
      fetch(`${second}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seenByDocument: { "/docs/second.md": ["second"] } }),
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await readConfig(SETTINGS_FILE, {})).toEqual({
      seenByDocument: {
        "/docs/first.md": ["first"],
        "/docs/second.md": ["second"],
      },
    });
  });

  test("host and origin checks protect launcher filesystem actions", async () => {
    const cwd = temp();
    const url = boot(cwd);
    const response = await fetch(`${url}/api/launcher/open`, {
      method: "POST",
      headers: {
        Host: "localhost:1234",
        Origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: "drive-by.md", create: true }),
    });

    expect(response.status).toBe(403);
    expect(await Bun.file(join(cwd, "drive-by.md")).exists()).toBe(false);
  });
});
