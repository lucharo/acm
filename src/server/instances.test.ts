import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "acm-instances-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

import { probeInstanceState, isConnectionRefused } from "./instances";
import type { InstanceEntry } from "./instances";

describe("instance registry", () => {
  test("register + resolve; dead pids are filtered and pruned", () => {
    // Config paths are process-global. Run the complete lifecycle in one child so
    // concurrently loaded server tests cannot redirect this registry mid-write.
    const instancesModule = new URL("./instances.ts", import.meta.url).href;
    const script = `
      import { join } from "node:path";
      import { registerInstance, liveInstances } from ${JSON.stringify(instancesModule)};

      const root = process.env.XDG_CONFIG_HOME;
      if (!root) throw new Error("missing XDG_CONFIG_HOME");

      await registerInstance(12000, "/tmp/live-doc.md");
      const file = join(root, "acm", "instances.json");
      const current = await Bun.file(file).json();
      current["12345"] = {
        port: 12345,
        doc: "/tmp/dead-doc.md",
        pid: 999999999,
        startedAt: "2026-01-01",
      };
      await Bun.write(file, JSON.stringify(current));

      const live = await liveInstances();
      await registerInstance(12001, "/tmp/second.md");
      const after = await Bun.file(file).json();
      console.log(JSON.stringify({
        live: live.map((entry) => ({
          port: entry.port,
          doc: entry.doc,
          pidMatches: entry.pid === process.pid,
        })),
        keys: Object.keys(after).sort(),
      }));
    `;

    const proc = Bun.spawnSync([process.execPath, "--eval", script], {
      env: { ...process.env, XDG_CONFIG_HOME: tmp },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.stderr.toString()).toBe("");
    expect(JSON.parse(proc.stdout.toString())).toEqual({
      live: [{ port: 12000, doc: "/tmp/live-doc.md", pidMatches: true }],
      keys: ["12000", "12001"],
    });
  });
});

describe("probeInstanceState — live vs dead vs unreachable", () => {
  const entry = (port: number): InstanceEntry => ({ port, doc: "/tmp/x.md", pid: process.pid, startedAt: "" });

  test("a server answering /api/doc is live", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => Response.json({ content: "", version: 0 }) });
    expect(await probeInstanceState(entry(srv.port!))).toBe("live");
    srv.stop();
  });

  test("a connection-refused port is dead (direct write is safe — nothing is there)", async () => {
    // Bind then close to get a port that's guaranteed free right now.
    const srv = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = srv.port!;
    srv.stop(true);
    expect(await probeInstanceState(entry(port))).toBe("dead");
  });

  test("a server that answers /api/doc with a 5xx is LIVE — any HTTP answer is proof of life", async () => {
    // An erroring-but-alive editor must still gate writes; a false "alive" fails
    // loudly at the agent-write POST, a false "dead" silently clobbers.
    const srv = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    expect(await probeInstanceState(entry(srv.port!))).toBe("live");
    srv.stop();
  });

  test("a socket that accepts but never responds is unreachable — NOT dead", async () => {
    // The loaded-machine / wedged-editor case: the probe must time out to
    // `unreachable` so write paths refuse the direct-write fallback (#38).
    const hang = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    expect(await probeInstanceState(entry(hang.port))).toBe("unreachable");
    hang.stop(true);
  });
});

describe("isConnectionRefused — discriminator shape robustness", () => {
  test("matches code on the error or its cause; rejects timeouts", () => {
    expect(isConnectionRefused({ code: "ConnectionRefused" })).toBe(true);
    expect(isConnectionRefused({ cause: { code: "ConnectionRefused" } })).toBe(true);
    expect(isConnectionRefused(Object.assign(new Error("x"), { code: "ConnectionRefused" }))).toBe(true);
    expect(isConnectionRefused(new DOMException("timed out", "TimeoutError"))).toBe(false);
    expect(isConnectionRefused({ name: "TimeoutError", code: 23 })).toBe(false);
    expect(isConnectionRefused(undefined)).toBe(false);
  });
});
