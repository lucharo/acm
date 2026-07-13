// ── Running-instance registry (~/.config/acm/instances.json) ───────────────────
// Every ACM server registers {port → doc, pid} at boot, so the `acm` verbs can
// resolve "the doc that's open in the editor" without --doc or ACM_DOC. Readers
// filter by PID LIVENESS — a crashed/killed server can't leave a convincing stale
// entry — and registration prunes dead entries as it writes. No unregister hook
// needed: liveness is the authority.

import { resolve } from "node:path";
import { readConfig, writeConfig } from "./config";

export interface InstanceEntry {
  port: number;
  doc: string; // absolute path of the served document
  pid: number;
  startedAt: string;
}

const FILE = "instances.json";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence probe, sends nothing
    return true;
  } catch {
    return false;
  }
}

/** Record this process as the ACM serving `doc` on `port` (prunes dead entries).
 *  KNOWN, tolerated race: concurrent read-modify-writes of instances.json can
 *  drop an entry (no file lock). Liveness is the authority, not the file — a
 *  lost entry re-registers on the next boot and readers verify pid + port
 *  anyway, so the worst case is a transient "no document" message. */
export async function registerInstance(port: number, doc: string): Promise<void> {
  const all = await readConfig<Record<string, InstanceEntry>>(FILE, {});
  for (const [key, e] of Object.entries(all)) {
    if (!isAlive(e.pid)) delete all[key];
  }
  all[String(port)] = {
    port,
    doc: resolve(doc),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await writeConfig(FILE, all);
}

/** Every registered instance whose process is still alive, sorted by port (so the
 *  prod convention :12000 lists first). */
export async function liveInstances(): Promise<InstanceEntry[]> {
  const all = await readConfig<Record<string, InstanceEntry>>(FILE, {});
  return Object.values(all)
    .filter((e) => isAlive(e.pid))
    .sort((a, b) => a.port - b.port);
}

/** Second-factor liveness: a recycled PID can impersonate a dead server, but it
 *  won't answer ACM's /api/doc on the registered port. Timeouts retry (up to 3
 *  attempts): a single short-timeout fetch false-negatives under CPU contention
 *  (a cold bun process is still transpiling while the fetch clock runs), and a
 *  false "dead" here lets a mutating verb direct-write past a LIVE editor — the
 *  exact clobber #38 guards against. A refused connection is a definitive fast
 *  "dead" (nothing listens there), so it never retries. ANY HTTP answer — even a
 *  5xx — is proof of life: an erroring-but-alive server must still gate writes
 *  (the agent-write POST then fails loudly, which is the safe direction). */
export async function probeInstance(e: InstanceEntry): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fetch(`http://localhost:${e.port}/api/doc`, {
        signal: AbortSignal.timeout(1000),
      });
      return true;
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      if (!timedOut) return false; // refused/reset — nothing lives on that port
      if (attempt < 2) await Bun.sleep(100);
    }
  }
  return false;
}
