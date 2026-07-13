// ── #38 regression: concurrent agent + editor writes must never clobber ───────
// Drives a REAL booted server over HTTP to reproduce the exact two-writer race —
// an agent write and a stale editor save landing near-simultaneously — and asserts
// that BOTH sides' content survives (disjoint) and that a true same-line overlap is
// an honest conflict rather than a silent overwrite.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../server";
import type { AcmServer } from "../../server";

const SEED = "Para one.\n\nPara two is here.\n";
const HUMAN = "Para one EDITED.\n\nPara two is here.\n"; // edits line 0
const CARD = "Para one.\n\nPara two is {==here==}{>>@claude: SUGGEST: present<<}.\n"; // edits line 2

const live: AcmServer[] = [];
let prevXdg: string | undefined;

beforeAll(() => {
  // Isolate the instance registry / settings from the user's real ~/.config/acm so
  // a live ACM on :12000 is never perturbed by the test's registerInstance writes.
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "acm-xdg-"));
});

afterAll(() => {
  // Restore the env so this file can't leak into other suites in the same process.
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
});

afterEach(() => {
  while (live.length) live.pop()!.stop();
});

async function boot(seed: string): Promise<{ url: string; docPath: string }> {
  const docPath = join(mkdtempSync(join(tmpdir(), "acm-doc-")), "doc.md");
  await Bun.write(docPath, seed);
  // Port 0 → the OS hands out a free ephemeral port, so parallel runs can't collide.
  const srv = startServer({ docPath, port: 0, staticDir: "./dist" });
  live.push(srv);
  // 127.0.0.1, not localhost: Bun's fetch can resolve localhost to ::1 while the
  // server listens on IPv4 only, and that connect hangs instead of refusing.
  const url = `http://127.0.0.1:${srv.server.port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/doc`)).ok) return { url, docPath };
    } catch {
      /* not up yet */
    }
    await Bun.sleep(10);
  }
  throw new Error(`ACM test server on ${url} failed to start`);
}

const J = { "content-type": "application/json" };
const put = async (url: string, content: string, baseVersion: number) => {
  const r = await fetch(`${url}/api/doc`, { method: "PUT", headers: J, body: JSON.stringify({ content, baseVersion }) });
  return { status: r.status, body: (await r.json()) as { version: number; content?: string; conflict?: string } };
};
const agentWrite = async (url: string, base: string, content: string) => {
  const r = await fetch(`${url}/api/agent-write`, { method: "POST", headers: J, body: JSON.stringify({ base, content }) });
  return { status: r.status, body: (await r.json()) as { version: number; content?: string; conflict?: string } };
};
const presence = (url: string, from: number, to: number) =>
  fetch(`${url}/api/presence`, { method: "PUT", headers: J, body: JSON.stringify({ from, to }) });
const disk = (docPath: string) => Bun.file(docPath).text();

describe("#38 — disjoint concurrent writes both survive", () => {
  test("agent writes a card, THEN a stale editor save (the exact repro)", async () => {
    const { url, docPath } = await boot(SEED);
    // Human is typing in para one (baseVersion still 0, not yet saved).
    const aw = await agentWrite(url, SEED, CARD); // agent's card lands first
    expect(aw.status).toBe(200);
    const save = await put(url, HUMAN, 0); // the stale autosave that used to clobber
    expect(save.status).toBe(200);

    const final = await disk(docPath);
    expect(final).toContain("EDITED"); // human edit survived
    expect(final).toContain("SUGGEST: present"); // agent card survived
    expect(save.body.content).toBe(final); // editor is handed the merged truth to adopt
  });

  test("editor saves first, THEN the agent writes (reverse order)", async () => {
    const { url, docPath } = await boot(SEED);
    expect((await put(url, HUMAN, 0)).status).toBe(200);
    const aw = await agentWrite(url, SEED, CARD); // base = pre-edit read
    expect(aw.status).toBe(200);

    const final = await disk(docPath);
    expect(final).toContain("EDITED");
    expect(final).toContain("SUGGEST: present");
  });
});

describe("#38 — the agent-avoids-cursor guard", () => {
  test("an agent write on the human's live caret span is declined", async () => {
    const { url, docPath } = await boot(SEED);
    const at = SEED.indexOf("here");
    await presence(url, at, at + 4); // caret sitting on the agent's target span
    const aw = await agentWrite(url, SEED, CARD);
    expect(aw.status).toBe(409);
    expect(aw.body.conflict).toBe("cursor");
    expect(await disk(docPath)).toBe(SEED); // nothing written — agent retries
  });

  test("an agent write far from the caret is allowed", async () => {
    const { url, docPath } = await boot(SEED);
    await presence(url, 0, 3); // caret in para one; agent targets para two
    expect((await agentWrite(url, SEED, CARD)).status).toBe(200);
    expect(await disk(docPath)).toContain("SUGGEST: present");
  });
});

describe("#38 — multi-region agent edit doesn't falsely 409 on a human edit between regions", () => {
  test("agent changes two separated lines while the human edits the middle → clean merge", async () => {
    const seed = "L0\nL1\nL2\nL3\nL4\n";
    const { url, docPath } = await boot(seed);
    // Human saves an edit to the MIDDLE line first → disk has it.
    expect((await put(url, "L0\nL1\nHUMAN2\nL3\nL4\n", 0)).status).toBe(200);
    // Agent edits two SEPARATED regions (L0 and L4) from the original base.
    const aw = await agentWrite(url, seed, "A0\nL1\nL2\nL3\nA4\n");
    expect(aw.status).toBe(200); // NOT a false `containment` 409 (the Codex finding)
    expect(await disk(docPath)).toBe("A0\nL1\nHUMAN2\nL3\nA4\n"); // all three survive
  });
});

describe("#38 — CLI never fakes success against a non-agent-write server (version skew)", () => {
  // 20s timeout: this test pays a full `bun cli.ts` subprocess boot (transpiling the
  // whole CLI graph, ~1–2.5s idle, worse under machine load) that the in-process
  // tests above don't; the default 5s trips on a loaded machine.
  test(
    "an older editor (serves HTML for /api/agent-write) → CLI hard-fails, no direct write",
    async () => {
    const docPath = join(mkdtempSync(join(tmpdir(), "acm-doc-")), "doc.md");
    const seed = "The quick brown fox jumps over the lazy dog.\n";
    await Bun.write(docPath, seed);

    // Stand-in for an OLD ACM: answers /api/doc (liveness probe passes) but serves its
    // SPA fallback (HTML, no agent-write route) for the POST.
    const oldAcm = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/api/doc") return Response.json({ content: seed, version: 0 });
        return new Response("<!doctype html><title>old acm</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });
    // Register it as the live instance owning this doc (temp XDG set in beforeAll).
    const cfg = join(process.env.XDG_CONFIG_HOME!, "acm");
    mkdirSync(cfg, { recursive: true });
    await Bun.write(
      join(cfg, "instances.json"),
      JSON.stringify({
        [String(oldAcm.port)]: { port: oldAcm.port, doc: docPath, pid: process.pid, startedAt: "2026-06-16T00:00:00Z" },
      }),
    );

    const proc = Bun.spawn(["bun", "cli.ts", "suggest", "lazy", "sleepy", "--doc", docPath], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    oldAcm.stop();

      expect(exit).not.toBe(0); // hard failure, not a fabricated success
      expect(await disk(docPath)).toBe(seed); // and the doc was NOT blindly direct-written
    },
    20_000,
  );

  test(
    "a registry entry whose port REFUSES (editor truly gone) → CLI direct-writes fine",
    async () => {
      // The counterpart guard: refused ≠ unreachable. A pid-alive registry entry
      // pointing at a closed port is a dead editor, and the CLI must still work
      // (direct write, single writer) rather than wedging behind the stale entry.
      const docPath = join(mkdtempSync(join(tmpdir(), "acm-doc-")), "doc.md");
      const seed = "The quick brown fox jumps over the lazy dog.\n";
      await Bun.write(docPath, seed);

      const ghost = Bun.serve({ port: 0, fetch: () => new Response("x") });
      const port = ghost.port;
      ghost.stop(true); // port now guaranteed closed — probes get ConnectionRefused

      const cfg = join(process.env.XDG_CONFIG_HOME!, "acm");
      mkdirSync(cfg, { recursive: true });
      await Bun.write(
        join(cfg, "instances.json"),
        JSON.stringify({
          [String(port)]: { port, doc: docPath, pid: process.pid, startedAt: "2026-06-16T00:00:00Z" },
        }),
      );

      const proc = Bun.spawn(["bun", "cli.ts", "suggest", "lazy", "sleepy", "--doc", docPath], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await proc.exited;

      expect(exit).toBe(0); // dead editor never blocks the CLI
      expect(await disk(docPath)).toContain("SUGGEST: sleepy"); // the edit landed directly
    },
    20_000,
  );

  test(
    "a registry entry whose port accepts but never answers (UNREACHABLE) → CLI hard-fails, no direct write",
    async () => {
      // The core #38 guarantee end-to-end: an indeterminate editor (alive but
      // wedged/slow — here a black-holed socket) must produce exit ≠ 0 with the
      // doc byte-identical, never a silent direct write.
      const docPath = join(mkdtempSync(join(tmpdir(), "acm-doc-")), "doc.md");
      const seed = "The quick brown fox jumps over the lazy dog.\n";
      await Bun.write(docPath, seed);

      const blackhole = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const cfg = join(process.env.XDG_CONFIG_HOME!, "acm");
      mkdirSync(cfg, { recursive: true });
      await Bun.write(
        join(cfg, "instances.json"),
        JSON.stringify({
          [String(blackhole.port)]: { port: blackhole.port, doc: docPath, pid: process.pid, startedAt: "2026-06-16T00:00:00Z" },
        }),
      );

      const proc = Bun.spawn(["bun", "cli.ts", "suggest", "lazy", "sleepy", "--doc", docPath], {
        cwd: process.cwd(),
        // Shrink the agent-write ceiling so this test doesn't cost 10 real seconds.
        env: { ...process.env, ACM_AGENT_WRITE_TIMEOUT_MS: "1500" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await proc.exited;
      blackhole.stop(true);

      expect(exit).not.toBe(0); // hard failure, not a fabricated success
      expect(await disk(docPath)).toBe(seed); // nothing written
    },
    20_000,
  );
});

describe("#38 — a true same-line overlap is an honest conflict, human never loses", () => {
  test("stale save onto the line the agent changed → 409, then human wins on re-save", async () => {
    const { url, docPath } = await boot(SEED);
    const aw = await agentWrite(url, SEED, CARD); // card on line 2
    expect(aw.status).toBe(200);

    // Human had edited the SAME line 2 from the original base (stale baseVersion 0).
    const humanLine2 = "Para one.\n\nPara two is RIGHT HERE now.\n";
    const conflict = await put(url, humanLine2, 0);
    expect(conflict.status).toBe(409);
    expect(conflict.body.conflict).toBe("overlap");
    expect(await disk(docPath)).toContain("SUGGEST: present"); // agent's card NOT clobbered by the stale save

    // The human adopts the server version and saves deliberately → their text wins.
    const win = await put(url, humanLine2, conflict.body.version);
    expect(win.status).toBe(200);
    expect(await disk(docPath)).toBe(humanLine2); // human content never lost
  });
});
