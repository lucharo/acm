import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withFileUpdateLock } from "./fileLock";

let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function lockPath(): string {
  dir = mkdtempSync(join(tmpdir(), "acm-file-lock-"));
  return join(dir, "shared.lock");
}

describe("cross-process file update lock", () => {
  test("overlapping callers enter the critical section one at a time", async () => {
    const path = lockPath();
    const order: string[] = [];
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withFileUpdateLock(path, "test file", async () => {
      order.push("first-start");
      firstEntered();
      await firstMayFinish;
      order.push("first-end");
    });
    await firstDidEnter;
    const second = withFileUpdateLock(path, "test file", async () => {
      order.push("second");
    });
    await Bun.sleep(20);

    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(existsSync(path)).toBe(false);
  });

  test("two contenders recover one dead owner without overlapping", async () => {
    const path = lockPath();
    mkdirSync(path);
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({ version: 1, token: "dead", pid: 999_999, createdAt: 0 }),
    );
    const options = {
      timeoutMs: 500,
      pollMs: 2,
      staleMs: 0,
      isProcessAlive: (pid: number) => pid === process.pid,
    };
    let active = 0;
    let maximumActive = 0;

    const run = () =>
      withFileUpdateLock(
        path,
        "test file",
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Bun.sleep(20);
          active -= 1;
        },
        options,
      );

    await Promise.all([run(), run()]);

    expect(maximumActive).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test("an ownerless stale lock remains reclaimable after the takeover claim", async () => {
    const path = lockPath();
    mkdirSync(path);
    utimesSync(path, new Date(0), new Date(0));

    const result = await withFileUpdateLock(
      path,
      "test file",
      async () => "recovered",
      { timeoutMs: 100, pollMs: 2, staleMs: 1 },
    );

    expect(result).toBe("recovered");
    expect(existsSync(path)).toBe(false);
  });

  test("cleanup leaves a replacement lock owned by another process intact", async () => {
    const path = lockPath();
    const displaced = `${path}.displaced`;

    await withFileUpdateLock(path, "test file", async () => {
      renameSync(path, displaced);
      mkdirSync(path);
      writeFileSync(
        join(path, "owner.json"),
        JSON.stringify({ version: 1, token: "replacement", pid: 42, createdAt: 1 }),
      );
    });

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(join(path, "owner.json"), "utf8"))).toEqual({
      version: 1,
      token: "replacement",
      pid: 42,
      createdAt: 1,
    });
  });

  test("failed owner setup leaves a replacement lock owned by another process intact", async () => {
    const path = lockPath();
    const displaced = `${path}.failed-setup`;
    let entered = false;

    await expect(
      withFileUpdateLock(
        path,
        "test file",
        async () => {
          entered = true;
        },
        {
          writeOwnerFile: async () => {
            renameSync(path, displaced);
            mkdirSync(path);
            writeFileSync(
              join(path, "owner.json"),
              JSON.stringify({ version: 1, token: "replacement", pid: 42, createdAt: 1 }),
            );
            throw new Error("owner write failed");
          },
        },
      ),
    ).rejects.toThrow("owner write failed");

    expect(entered).toBe(false);
    expect(JSON.parse(readFileSync(join(path, "owner.json"), "utf8"))).toEqual({
      version: 1,
      token: "replacement",
      pid: 42,
      createdAt: 1,
    });
  });

  test("failed owner setup leaves its lock for guarded stale recovery", async () => {
    const path = lockPath();

    await expect(
      withFileUpdateLock(path, "test file", async () => "entered", {
        writeOwnerFile: async () => {
          throw new Error("owner write failed");
        },
      }),
    ).rejects.toThrow("owner write failed");
    expect(existsSync(path)).toBe(true);

    utimesSync(path, new Date(0), new Date(0));
    const recovered = await withFileUpdateLock(
      path,
      "test file",
      async () => "recovered",
      { timeoutMs: 100, pollMs: 2, staleMs: 1 },
    );

    expect(recovered).toBe("recovered");
    expect(existsSync(path)).toBe(false);
  });

  test("a dead lock file from the previous implementation is reclaimed on upgrade", async () => {
    const path = lockPath();
    writeFileSync(path, "999999 2026-08-04T12:00:00.000Z\n");
    let active = 0;
    let maximumActive = 0;
    const run = () =>
      withFileUpdateLock(
        path,
        "test file",
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Bun.sleep(10);
          active -= 1;
          return "recovered";
        },
        {
          timeoutMs: 100,
          pollMs: 2,
          staleMs: 30_000,
          isProcessAlive: (pid) => pid === process.pid,
        },
      );

    const results = await Promise.all([run(), run()]);

    expect(results).toEqual(["recovered", "recovered"]);
    expect(maximumActive).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test("a live lock file from the previous implementation is not reclaimed", async () => {
    const path = lockPath();
    const legacy = `${process.pid} 2026-08-04T12:00:00.000Z\n`;
    writeFileSync(path, legacy);

    await expect(
      withFileUpdateLock(path, "test file", async () => "entered", {
        timeoutMs: 20,
        pollMs: 2,
        staleMs: 30_000,
        isProcessAlive: (pid) => pid === process.pid,
      }),
    ).rejects.toThrow("Timed out waiting to update ACM test file");

    expect(readFileSync(path, "utf8")).toBe(legacy);
  });

  test("an old legacy lock is reclaimed when its pid has been reused", async () => {
    const path = lockPath();
    writeFileSync(path, `${process.pid} 2026-08-04T12:00:00.000Z\n`);
    utimesSync(path, new Date(0), new Date(0));

    const result = await withFileUpdateLock(
      path,
      "test file",
      async () => "recovered",
      {
        timeoutMs: 100,
        pollMs: 2,
        staleMs: 1,
        isProcessAlive: (pid) => pid === process.pid,
      },
    );

    expect(result).toBe("recovered");
    expect(existsSync(path)).toBe(false);
  });
});
