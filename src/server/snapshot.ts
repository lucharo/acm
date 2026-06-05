// ── Doc snapshots (safety net before mutating ops) ────────────────────────────
// Before any agent verb (or, later, a server-side heal/resolve) rewrites the doc,
// drop a timestamped copy. Plain files keep the "plain text is truth" ethos (no DB).
//   <docDir>/.acm/snapshots/<docName>/<ISO>-<trigger>.md
// Capped by count so it can't grow unbounded — important because <docDir> may live
// under a synced tree (the .acm dir is gitignored AND should be sync-ignored).

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, basename, join } from "node:path";

const MAX_SNAPSHOTS = 50;

/** Copy `docPath` into its `.acm/snapshots/<docName>/` dir, tagged with `trigger`
 *  (e.g. "apply", "accept"). Returns the snapshot path, or null if the doc is
 *  unreadable. Prunes to the newest MAX_SNAPSHOTS. `ts` lets callers pass a fixed
 *  timestamp (tests); defaults to now. */
export async function snapshot(docPath: string, trigger: string, ts = new Date()): Promise<string | null> {
  const file = Bun.file(docPath);
  if (!(await file.exists())) return null;
  const content = await file.text();
  const dir = join(dirname(docPath), ".acm", "snapshots", basename(docPath));
  mkdirSync(dir, { recursive: true });
  const stamp = ts.toISOString().replace(/[:.]/g, "-");
  const out = join(dir, `${stamp}-${trigger}.md`);
  await Bun.write(out, content);
  prune(dir);
  return out;
}

function prune(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort(); // ISO timestamps sort chronologically
  for (const f of files.slice(0, Math.max(0, files.length - MAX_SNAPSHOTS))) {
    rmSync(join(dir, f));
  }
}
