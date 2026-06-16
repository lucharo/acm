// ── #38 regression: concurrent agent + editor writes must never clobber ───────
// Drives a REAL booted server over HTTP to reproduce the exact two-writer race —
// an agent write and a stale editor save landing near-simultaneously — and asserts
// that BOTH sides' content survives (disjoint) and that a true same-line overlap is
// an honest conflict rather than a silent overwrite.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../server";
import type { AcmServer } from "../../server";

const SEED = "Para one.\n\nPara two is here.\n";
const HUMAN = "Para one EDITED.\n\nPara two is here.\n"; // edits line 0
const CARD = "Para one.\n\nPara two is {==here==}{>>@claude: SUGGEST: present<<}.\n"; // edits line 2

let nextPort = 13000 + Math.floor(Math.random() * 500);
const live: AcmServer[] = [];

beforeAll(() => {
  // Isolate the instance registry / settings from the user's real ~/.config/acm so
  // a live ACM on :12000 is never perturbed by the test's registerInstance writes.
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "acm-xdg-"));
});

afterEach(() => {
  while (live.length) live.pop()!.stop();
});

async function boot(seed: string): Promise<{ url: string; docPath: string }> {
  const docPath = join(mkdtempSync(join(tmpdir(), "acm-doc-")), "doc.md");
  await Bun.write(docPath, seed);
  const port = nextPort++;
  live.push(startServer({ docPath, port, staticDir: "./dist" }));
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/doc`)).ok) break;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(10);
  }
  return { url, docPath };
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
