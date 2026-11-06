// Keep a child process running: when it exits on its own, restart it with a
// backoff instead of tearing everything down (#34 — `bun run dev` used to race
// its two children and exit the moment either one stopped).

export interface SupervisorOptions {
  /** Delay before restart attempt n (1-based) of an unbroken crash streak. */
  backoffMs?: (attempt: number) => number;
  /** A child that ran at least this long resets the crash streak. */
  healthyAfterMs?: number;
  log?: (line: string) => void;
}

export interface Supervisor {
  /** Stop restarting and kill the current child. */
  stop(): Promise<void>;
  /** Children spawned so far (first start included). */
  readonly starts: number;
}

const defaultBackoff = (attempt: number) => Math.min(500 * 2 ** (attempt - 1), 10_000);

export function supervise(
  name: string,
  spawn: () => { exited: Promise<number | null>; kill(): void },
  opts: SupervisorOptions = {},
): Supervisor {
  const backoff = opts.backoffMs ?? defaultBackoff;
  const healthyAfter = opts.healthyAfterMs ?? 10_000;
  const log = opts.log ?? ((line: string) => console.error(line));
  let stopped = false;
  let starts = 0;
  let current: { exited: Promise<number | null>; kill(): void } | null = null;
  let wake: (() => void) | null = null;

  const loop = (async () => {
    let streak = 0;
    while (!stopped) {
      const startedAt = Date.now();
      let outcome: string;
      try {
        current = spawn();
        starts++;
        outcome = `exited (code ${await current.exited})`;
      } catch (error) {
        current = null; // the launch itself failed (e.g. EAGAIN): retry like a crash
        outcome = `failed to start (${(error as Error).message})`;
      }
      if (stopped) break;
      streak = Date.now() - startedAt >= healthyAfter ? 1 : streak + 1;
      const delay = backoff(streak);
      log(`dev: ${name} ${outcome}; restarting in ${delay}ms`);
      await new Promise<void>((done) => {
        wake = done;
        setTimeout(done, delay);
      });
      wake = null;
    }
  })();

  return {
    get starts() {
      return starts;
    },
    async stop() {
      stopped = true;
      current?.kill();
      wake?.();
      await loop;
    },
  };
}
