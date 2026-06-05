// ── ACM config home (XDG) ──────────────────────────────────────────────────────
// Persisted preferences / review-state live in a real config dir, not the browser:
//   $XDG_CONFIG_HOME/acm/  (default ~/.config/acm/)
// Generic read/write JSON helpers, reused for settings.json today and the planned
// recent-files store + in-app skill editor. The browser never touches the fs — it
// goes through the server's /api/settings; these helpers are the server side.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/** $XDG_CONFIG_HOME/acm, else ~/.config/acm. */
export function configHome(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "acm");
}

/** Parse a JSON config file from the ACM config home, or `fallback` if it's missing
 *  or unparseable (a fresh install, or a hand-corrupted file — never throws). */
export async function readConfig<T>(name: string, fallback: T): Promise<T> {
  try {
    const file = Bun.file(join(configHome(), name));
    if (!(await file.exists())) return fallback;
    return (await file.json()) as T;
  } catch {
    return fallback;
  }
}

/** Write `data` as pretty JSON to a config file in the ACM config home (mkdir -p). */
export async function writeConfig(name: string, data: unknown): Promise<void> {
  mkdirSync(configHome(), { recursive: true });
  await Bun.write(join(configHome(), name), JSON.stringify(data, null, 2));
}
