// ── Running-instance registry (~/.config/acm/instances.json) ───────────────────
// Every ACM server registers {port → doc, pid} at boot, so the `acm` verbs can
// resolve "the doc that's open in the editor" without --doc or ACM_DOC. Readers
// filter by PID LIVENESS — a crashed/killed server can't leave a convincing stale
// entry — and registration prunes dead entries as it writes. No unregister hook
// needed: liveness is the authority.

import { resolve } from "node:path";
import { readConfig, updateConfig } from "./config";

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

/** Record this process as the ACM serving `doc` on `port` (prunes dead entries). */
export async function registerInstance(port: number, doc: string): Promise<void> {
  await updateConfig<Record<string, InstanceEntry>>(FILE, {}, (current) => {
    const all = { ...current };
    for (const [key, e] of Object.entries(all)) {
      if (!isAlive(e.pid)) delete all[key];
    }
    all[String(port)] = {
      port,
      doc: resolve(doc),
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    return all;
  });
}

/** Every registered instance whose process is still alive, sorted by port (so the
 *  prod convention :12000 lists first). */
export async function liveInstances(): Promise<InstanceEntry[]> {
  const all = await readConfig<Record<string, InstanceEntry>>(FILE, {});
  return Object.values(all)
    .filter((e) => isAlive(e.pid))
    .sort((a, b) => a.port - b.port);
}

/** What a port probe established: `live` (answered /api/doc — ANY HTTP answer,
 *  even a 5xx, is proof of life: an erroring-but-alive server must still gate
 *  writes, and a false "alive" fails loudly at the agent-write POST), `dead`
 *  (connection refused — nothing listens there), or `unreachable` (timed out or
 *  otherwise indeterminate — the editor may be alive but slow/blocked). Writers
 *  must treat `unreachable` as possibly-live and NOT fall back to a direct write:
 *  a loaded machine turning a live editor's slow accept into a "dead" verdict is
 *  exactly the silent-clobber path issue #38 exists to close. */
export type ProbeState = "live" | "dead" | "unreachable";

/** Was this fetch rejection a connection REFUSED (nothing listening — truly dead)?
 *  Bun surfaces it as `err.code === "ConnectionRefused"` today; check `cause` and
 *  `name` too so a Bun upgrade moving the code can't silently turn every refusal
 *  into "unreachable" (which would wedge CLI writes behind a stale registry entry).
 *  The single discriminator for every caller — don't re-derive it inline. */
export function isConnectionRefused(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown; cause?: { code?: unknown; name?: unknown } };
  return (
    e?.code === "ConnectionRefused" ||
    e?.name === "ConnectionRefused" ||
    e?.cause?.code === "ConnectionRefused" ||
    e?.cause?.name === "ConnectionRefused"
  );
}

/** Second-factor liveness: a recycled PID can impersonate a dead server, but it
 *  won't answer ACM's /api/doc on the registered port. Short timeout — local.
 *  127.0.0.1, not localhost: Bun's fetch can resolve localhost to ::1 while
 *  Bun.serve listens on IPv4 only, and the mismatched connect HANGS (not refuses)
 *  until the abort — a false "dead" for a perfectly live editor. */
export async function probeInstanceState(e: InstanceEntry): Promise<ProbeState> {
  const attempt = async (budgetMs: number): Promise<ProbeState> => {
    try {
      await fetch(`http://127.0.0.1:${e.port}/api/doc`, {
        signal: AbortSignal.timeout(budgetMs),
      });
      return "live"; // any HTTP answer — even a 5xx — is proof of life (see ProbeState)
    } catch (err) {
      return isConnectionRefused(err) ? "dead" : "unreachable";
    }
  };
  // Fast path 400ms; but `unreachable` is FATAL for the write paths, so before
  // declaring it, retry once with a generous budget — a single short-timeout fetch
  // false-negatives under CPU contention (a cold bun process is still transpiling
  // while the fetch clock runs), and that's the very case this exists for.
  const fast = await attempt(400);
  return fast === "unreachable" ? attempt(3_000) : fast;
}
