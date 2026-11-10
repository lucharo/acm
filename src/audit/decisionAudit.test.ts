// ── Decision-history audit: POST/GET /api/decisions, GET /api/decision-recovery ──
// Regressions from the 2026-11 correctness audit (#21). Every test drives the real
// routes of a real server, with a temp XDG_CONFIG_HOME and temp documents.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startServer } from "../../server";
import type { AcmServer } from "../../server";
import type { DecisionEvent } from "../lib/decision";
import { decisionLogPath } from "../server/decisions";
import { decisionRecoveryPath } from "../server/decisionRecovery";

const J = { "content-type": "application/json" };
const live: AcmServer[] = [];
let prevXdg: string | undefined;

beforeAll(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "acm-decision-audit-xdg-"));
});
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
});
afterEach(() => {
  while (live.length) live.pop()!.stop();
});

function decision(id: string, overrides: Partial<DecisionEvent> = {}): DecisionEvent {
  return {
    id,
    timestamp: "2026-11-09T12:00:00.000Z",
    action: "accept",
    actor: "Luis",
    source: "gui",
    target: { kind: "comment", id: `comment-${id}` },
    anchor: "original",
    originalText: "original",
    proposedText: "replacement",
    resultingText: "replacement",
    ...overrides,
  };
}

const newDocPath = () => join(mkdtempSync(join(tmpdir(), "acm-decision-audit-doc-")), "doc.md");
const auditDiskDown = {
  appendDecisionEvents: async (): Promise<{ appended: number }> => {
    throw new Error("audit disk down");
  },
};

async function boot(docPath = newDocPath(), opts: Partial<Parameters<typeof startServer>[0]> = {}) {
  if (!existsSync(docPath)) await Bun.write(docPath, "before\n");
  const server = startServer({ docPath, port: 0, staticDir: "./dist", ...opts });
  live.push(server);
  return { url: `http://127.0.0.1:${server.server.port}`, docPath };
}
type Booted = Awaited<ReturnType<typeof boot>>;

async function postDecisions(b: Booted, events: unknown[]) {
  const response = await fetch(`${b.url}/api/decisions`, {
    method: "POST",
    headers: J,
    body: JSON.stringify({ documentPath: b.docPath, decisionEvents: events }),
  });
  const text = await response.text();
  return { status: response.status, text };
}
const getJson = async (b: Booted, route: string) => (await fetch(`${b.url}${route}`)).json();

describe("audit: POST /api/decisions refuses malformed input", () => {
  test("a timestamp ACM could never have emitted is refused and nothing is written", async () => {
    const b = await boot();
    const statuses = [];
    for (const timestamp of ["foo 12", "1", "2026-02-31"]) {
      statuses.push((await postDecisions(b, [decision("bad-time", { timestamp })])).status);
    }
    expect({
      statuses,
      history: await getJson(b, "/api/decisions"),
      logWritten: existsSync(decisionLogPath(b.docPath)),
    }).toEqual({ statuses: [400, 400, 400], history: { decisionEvents: [] }, logWritten: false });
  });

  test("a whitespace-only event id is refused and nothing is written", async () => {
    const b = await boot();
    const response = await postDecisions(b, [decision("   ")]);
    expect({
      status: response.status,
      history: await getJson(b, "/api/decisions"),
      logWritten: existsSync(decisionLogPath(b.docPath)),
    }).toEqual({ status: 400, history: { decisionEvents: [] }, logWritten: false });
  });

  test("a body that is not valid UTF-8 is refused instead of being stored with mangled text", async () => {
    const b = await boot();
    const bytes = Buffer.from(JSON.stringify({ documentPath: b.docPath, decisionEvents: [decision("bytes", { actor: "LuXs" })] }));
    bytes[bytes.indexOf("LuXs") + 2] = 0xff;
    const response = await fetch(`${b.url}/api/decisions`, { method: "POST", headers: J, body: bytes });
    expect({
      status: response.status,
      text: await response.text(),
      history: await getJson(b, "/api/decisions"),
      logWritten: existsSync(decisionLogPath(b.docPath)),
    }).toEqual({ status: 400, text: "Bad request: invalid JSON", history: { decisionEvents: [] }, logWritten: false });
  });
});

describe("audit: GET /api/decisions on a damaged log", () => {
  test("a line with invalid UTF-8 is reported, not served with replacement characters, and hides nothing", async () => {
    const b = await boot();
    const log = decisionLogPath(b.docPath);
    mkdirSync(dirname(log), { recursive: true });
    const damaged = Buffer.from(JSON.stringify(decision("damaged")));
    damaged[damaged.indexOf("Luis")] = 0xff;
    const valid = decision("valid");
    writeFileSync(log, Buffer.concat([damaged, Buffer.from(`\n${JSON.stringify(valid)}\n`)]));

    expect(await getJson(b, "/api/decisions")).toEqual({
      decisionEvents: [valid],
      decisionHistoryIssues: [
        { line: 1, code: "invalid-json", message: "Decision history line 1 contains invalid JSON." },
      ],
    });
  });
});

describe("audit: GET /api/decision-recovery", () => {
  test("recovery evidence survives a restart under another spelling of the document's folder", async () => {
    const real = mkdtempSync(join(tmpdir(), "acm-decision-audit-real-"));
    const alias = join(mkdtempSync(join(tmpdir(), "acm-decision-audit-alias-")), "link");
    symlinkSync(real, alias);
    const event = decision("spelled");
    const first = await boot(join(alias, "doc.md"), auditDiskDown);
    expect((await postDecisions(first, [event])).status).toBe(500);
    live.pop()!.stop();

    const reopened = await boot(join(real, "doc.md"));
    const recovered = await getJson(reopened, "/api/decision-recovery");
    const retried = await postDecisions(reopened, [event]);

    expect({
      recovered,
      retried: retried.status,
      afterRetry: await getJson(reopened, "/api/decision-recovery"),
      history: await getJson(reopened, "/api/decisions"),
    }).toEqual({
      recovered: { decisionEvents: [event] },
      retried: 200,
      afterRetry: { decisionEvents: [] },
      history: { decisionEvents: [event] },
    });
  });

  test("two writers reclaiming a crashed lock keep both recovery entries", async () => {
    const docPath = newDocPath();
    const a = await boot(docPath, auditDiskDown);
    const b = await boot(docPath, auditDiskDown);
    const recovery = decisionRecoveryPath(docPath);
    const lock = `${recovery}.lock`;
    const crashed = "999999 crashed\n";
    mkdirSync(dirname(recovery), { recursive: true });
    writeFileSync(lock, crashed);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    // Both writers must see the crashed lock as stale before either removes it, and
    // the later one must act on that stale view once the first has re-taken the lock.
    const realStat = fsPromises.stat;
    const realRename = fsPromises.rename;
    let staleViews = 0;
    let bothSawStale!: () => void;
    const staleSeenTwice = new Promise<void>((done) => (bothSawStale = done));
    const lockRetaken = async () => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        try {
          if (readFileSync(lock, "utf8") !== crashed) return;
        } catch {
          /* mid-replacement */
        }
        await Bun.sleep(1);
      }
    };
    const statSpy = spyOn(fsPromises, "stat").mockImplementation((async (...args: Parameters<typeof realStat>) => {
      const seen = await realStat(...args);
      if (String(args[0]) === lock) {
        staleViews += 1;
        if (staleViews === 1) await staleSeenTwice;
        else if (staleViews === 2) {
          bothSawStale();
          await lockRetaken();
        }
      }
      return seen;
    }) as typeof realStat);
    // Hold the first write open long enough for an escaped second writer to read
    // the same empty state; a correctly locked one just waits its turn.
    let recoveryWrites = 0;
    let secondWrote!: () => void;
    const secondWriteStarted = new Promise<void>((done) => (secondWrote = done));
    const renameSpy = spyOn(fsPromises, "rename").mockImplementation(async (...args: Parameters<typeof realRename>) => {
      if (String(args[1]) === recovery) {
        recoveryWrites += 1;
        if (recoveryWrites === 1) await Promise.race([secondWriteStarted, Bun.sleep(300)]);
        else secondWrote();
      }
      return realRename(...args);
    });

    try {
      const [first, second] = await Promise.all([
        postDecisions(a, [decision("from-a")]),
        postDecisions(b, [decision("from-b")]),
      ]);
      const stored = (await getJson(a, "/api/decision-recovery")) as { decisionEvents: DecisionEvent[] };
      expect({
        statuses: [first.status, second.status],
        recovery: [JSON.parse(first.text).audit.recovery, JSON.parse(second.text).audit.recovery],
        recovered: stored.decisionEvents.map((event) => event.id).sort(),
      }).toEqual({
        statuses: [500, 500],
        recovery: [{ status: "stored" }, { status: "stored" }],
        recovered: ["from-a", "from-b"],
      });
    } finally {
      bothSawStale();
      statSpy.mockRestore();
      renameSpy.mockRestore();
    }
  }, 15_000);
});
