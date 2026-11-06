import { describe, expect, test } from "bun:test";
import { supervise } from "./supervise";

const crashingChild = () => Bun.spawn([process.execPath, "-e", "process.exit(3)"], { stdout: "ignore", stderr: "ignore" });
const longChild = () => Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await Bun.sleep(10);
  }
}

describe("supervise", () => {
  test("a child that exits is restarted, not left dead", async () => {
    const lines: string[] = [];
    const sup = supervise("server", crashingChild, { backoffMs: () => 1, log: (l) => lines.push(l) });

    await until(() => sup.starts >= 3);
    await sup.stop();

    expect(lines[0]).toBe("dev: server exited (code 3); restarting in 1ms");
  });

  test("stop kills the running child and ends the restart loop", async () => {
    let child: ReturnType<typeof longChild> | null = null;
    const sup = supervise("vite", () => (child = longChild()), { backoffMs: () => 1, log: () => {} });
    await until(() => child !== null);

    await sup.stop();
    const startsAfterStop = sup.starts;
    await Bun.sleep(50);

    expect(child!.killed).toBe(true);
    expect(sup.starts).toBe(startsAfterStop);
  });

  test("a spawn that throws is retried with backoff, then recovers", async () => {
    let calls = 0;
    const lines: string[] = [];
    const sup = supervise(
      "server",
      () => {
        calls++;
        if (calls === 2) throw new Error("EAGAIN");
        return crashingChild();
      },
      { backoffMs: () => 1, log: (l) => lines.push(l) },
    );

    await until(() => calls >= 3);
    await sup.stop();

    expect(lines.slice(0, 2)).toEqual([
      "dev: server exited (code 3); restarting in 1ms",
      "dev: server failed to start (EAGAIN); restarting in 1ms",
    ]);
  });

  test("the backoff grows over a crash streak", async () => {
    const delays: number[] = [];
    const sup = supervise("server", crashingChild, {
      backoffMs: (attempt) => {
        delays.push(attempt);
        return 1;
      },
      healthyAfterMs: 60_000,
      log: () => {},
    });

    await until(() => delays.length >= 3);
    await sup.stop();

    expect(delays.slice(0, 3)).toEqual([1, 2, 3]);
  });
});
