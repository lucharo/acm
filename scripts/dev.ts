// Dev orchestrator: runs the Bun API/WS server + the Vite dev server together.
//
// Port convention: 12000 is RESERVED for the PRODUCTION instance (`just prod` /
// `acm <file>` — the one actually editing your doc). Development must never squat
// on it, so we pick a RANDOM Vite port in 12000+[1,500) each run and put the API
// on a free port well above that. Open the printed URL — it has live source + HMR
// and proxies /api + /ws to the Bun server. (Edits still reach the browser over the
// Bun WebSocket, not Vite HMR — see vite.config.ts.)

import { copyFileSync, existsSync, mkdirSync } from "node:fs";

/** True if `port` is bindable right now (probe by briefly listening). */
function isFree(port: number): boolean {
  try {
    Bun.serve({ port, fetch: () => new Response("") }).stop(true);
    return true;
  } catch {
    return false;
  }
}

/** A random free Vite port in 12000+[1,500) whose paired API port (+500) is also
 *  free — leaving 12000 itself for production. */
function pickDevPort(): number {
  for (let i = 0; i < 50; i++) {
    const p = 12001 + Math.floor(Math.random() * 499); // [12001, 12499]
    if (isFree(p) && isFree(p + 500)) return p;
  }
  throw new Error("dev: could not find a free port in 12001–12499");
}

/**
 * Default dev doc: a gitignored WORKING COPY of the seed (#19) — so dev editing
 * and accept/reject testing never dirty the committed fixture. Seeded once;
 * subsequent runs keep your working copy. An explicit ACM_DOC always wins.
 */
function defaultDevDoc(): string {
  const seed = "seed/sample-essay.md";
  const work = ".acm-data/sample-essay.md";
  mkdirSync(".acm-data", { recursive: true });
  if (!existsSync(work)) copyFileSync(seed, work);
  return work;
}

const devPort = pickDevPort();
const apiPort = devPort + 500; // [12501, 12999] — clear of the dev range and prod 12000
const doc = process.env.ACM_DOC || defaultDevDoc();
const env = {
  ...process.env,
  ACM_PORT: String(apiPort),
  ACM_DEV_PORT: String(devPort),
  ACM_DOC: doc,
};

const procs = [
  Bun.spawn(["bun", "--watch", "server.ts"], { stdout: "inherit", stderr: "inherit", env }),
  Bun.spawn(["bunx", "vite"], { stdout: "inherit", stderr: "inherit", env }),
];

const url = `http://localhost:${devPort}`;
console.log(`\n  ACM dev → ${url}   (API :${apiPort}; prod stays on :12000)\n  doc: ${doc}\n`);
// Give Vite a moment to bind, then open the browser to the random dev URL.
setTimeout(() => Bun.spawn(["open", url]), 1500);

function shutdown() {
  for (const p of procs) p.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race(procs.map((p) => p.exited));
shutdown();
