// ── File-lock audit: stale-lock takeover ──────────────────────────────────────
// Defects found by the 2026-11 correctness audit of src/server/fileLock.ts (#21).
// Every test drives withFileUpdateLock on real files in a temp dir. The on-disk
// fixtures are the states a real SIGKILL leaves behind, and a dead pid is the pid of
// a process this test already ran to exit.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withFileUpdateLock, type FileUpdateLockOptions } from "../server/fileLock";

let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function lockPath(): string {
  dir = mkdtempSync(join(tmpdir(), "acm-lock-audit-"));
  return join(dir, "shared.lock");
}

const ancient = new Date(0);
const deadPid = () => Bun.spawnSync(["true"]).pid;
const ownerJson = (token: string, pid: number) =>
  JSON.stringify({ version: 1, token, pid, createdAt: 0 });

/** The lock directory a crash leaves behind. Each phase of a test seeds its own, so a
 *  phase that wrongly took the lock over fails the assertion, not the next fixture. */
function seedAbandonedLock(path: string, claim: string, owner?: string): string {
  mkdirSync(path, { recursive: true });
  if (owner !== undefined) writeFileSync(join(path, "owner.json"), owner);
  const claimPath = join(path, "takeover.json");
  writeFileSync(claimPath, claim);
  return claimPath;
}

/** Run the protected section, reporting "entered" or a short failure label. */
const attempt = (path: string, options: FileUpdateLockOptions) =>
  withFileUpdateLock(path, "audit file", async () => "entered", options).catch((error: Error) =>
    error.message.includes("Timed out") ? "timed out" : error.message,
  );

describe("audit: a crash mid-takeover does not wedge the lock", () => {
  test("a takeover claim blocks contenders only while its claimer is alive", async () => {
    const path = lockPath();
    const deadOwner = ownerJson("dead-owner", deadPid());
    const claim = seedAbandonedLock(path, ownerJson("live-claim", process.pid), deadOwner);

    const whileClaimerLives = await attempt(path, { timeoutMs: 50, pollMs: 2 });
    const claimWhileLive = existsSync(claim) ? readFileSync(claim, "utf8") : null;
    seedAbandonedLock(path, ownerJson("crashed-claim", deadPid()), deadOwner);
    const racing = { timeoutMs: 2_000, pollMs: 2 };
    let active = 0;
    let maximumActive = 0;
    const contender = () =>
      withFileUpdateLock(
        path,
        "audit file",
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Bun.sleep(10);
          active -= 1;
          return "entered";
        },
        racing,
      ).catch((error: Error) => error.message);
    const afterCrash = await Promise.all([contender(), contender()]);

    expect({
      whileClaimerLives,
      claimWhileLive,
      afterCrash,
      maximumActive,
      lockExists: existsSync(path),
    }).toEqual({
      whileClaimerLives: "timed out",
      claimWhileLive: ownerJson("live-claim", process.pid),
      afterCrash: ["entered", "entered"],
      maximumActive: 1,
      lockExists: false,
    });
  });

  test("a torn takeover claim blocks contenders only until it is stale", async () => {
    const path = lockPath();
    const claim = seedAbandonedLock(path, "");
    utimesSync(path, ancient, ancient);
    const options = { timeoutMs: 50, pollMs: 2, staleMs: 60_000 };

    const whileFresh = await attempt(path, options);
    seedAbandonedLock(path, "");
    utimesSync(claim, ancient, ancient);
    utimesSync(path, ancient, ancient);
    const onceStale = await attempt(path, { ...options, timeoutMs: 2_000 });

    expect({ whileFresh, onceStale, lockExists: existsSync(path) }).toEqual({
      whileFresh: "timed out",
      onceStale: "entered",
      lockExists: false,
    });
  });
});

describe("audit: a live holder's lock is never stolen", () => {
  // Running as root the file stays readable, so the contender times out on the live
  // pid instead: both are refusals, which is why the assertion names no error.
  test("an owner file the contender cannot read does not count as no owner", async () => {
    const path = lockPath();
    const owner = join(path, "owner.json");
    mkdirSync(path);
    writeFileSync(owner, ownerJson("live-owner", process.pid));
    chmodSync(owner, 0o000);
    utimesSync(path, ancient, ancient);

    const result = await attempt(path, { timeoutMs: 50, pollMs: 2, staleMs: 1 });
    const lockEntries = existsSync(path) ? readdirSync(path) : null;

    expect({ entered: result === "entered", lockEntries }).toEqual({
      entered: false,
      lockEntries: ["owner.json"],
    });
  });
});

describe("audit: a setup that lost its directory leaves the replacement alone", () => {
  test("an owner file written into a replacement lock is taken back out", async () => {
    const path = lockPath();
    const slowSetup: FileUpdateLockOptions = {
      // The first lock is taken over while this setup stalls, and the replacement
      // holder has made its directory but not written its own owner file yet.
      writeOwnerFile: async (file, contents) => {
        renameSync(path, `${path}.taken-over`);
        mkdirSync(path);
        writeFileSync(file, contents, { flag: "wx" });
      },
    };

    const slow = await attempt(path, slowSetup);
    const replacementEntries = readdirSync(path);
    utimesSync(path, ancient, ancient);
    const nextCaller = await attempt(path, { timeoutMs: 2_000, pollMs: 2, staleMs: 1 });

    expect({ slow, replacementEntries, nextCaller }).toEqual({
      slow: "ACM audit file lock changed owner during setup",
      replacementEntries: [],
      nextCaller: "entered",
    });
  });
});
