// ── ACM config home (XDG) ──────────────────────────────────────────────────────
// Persisted preferences / review-state live in a real config dir, not the browser:
//   $XDG_CONFIG_HOME/acm/  (default ~/.config/acm/)
// Generic read/write JSON helpers, reused for global settings and recent documents.
// The browser never touches the fs — it goes through server routes; these helpers
// are the server side.

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";

export const SETTINGS_FILE = "settings.json";

export class ConfigIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigIntegrityError";
  }
}

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

/** Read integrity-sensitive JSON. Missing files use `fallback`; malformed JSON
 * or a value rejected by `parse` remains visible to the caller. */
export async function readConfigStrict<T>(
  name: string,
  fallback: T,
  parse: (value: unknown) => T | null,
): Promise<T> {
  try {
    const value = JSON.parse(await readFile(configPath(name), "utf8")) as unknown;
    const parsed = parse(value);
    if (parsed === null) {
      throw new ConfigIntegrityError(`ACM config ${name} has an invalid shape`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      throw new ConfigIntegrityError(`ACM config ${name} contains invalid JSON`, {
        cause: error,
      });
    }
    throw error;
  }
}

function configPath(name: string): string {
  return join(configHome(), name);
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Write `data` atomically as pretty JSON to a config file in the ACM config home. */
export async function writeConfig(name: string, data: unknown): Promise<void> {
  const path = configPath(name);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await Bun.write(temporary, JSON.stringify(data, null, 2));
    await rename(temporary, path);
  } catch (error) {
    await removeIfPresent(temporary);
    throw error;
  }
}

export async function deleteConfig(name: string): Promise<void> {
  await removeIfPresent(configPath(name));
}

const CONFIG_LOCK_TIMEOUT_MS = 5_000;
const CONFIG_LOCK_STALE_MS = 30_000;

/** Hold the per-file cross-process lock for a complete config mutation. */
export async function withConfigUpdateLock<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = `${configPath(name)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs > CONFIG_LOCK_STALE_MS) {
          await removeIfPresent(lockPath);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to update ACM config ${name}`);
      }
      await Bun.sleep(10);
    }
  }

  try {
    return await run();
  } finally {
    await removeIfPresent(lockPath);
  }
}

/** Serialize a complete read-modify-write across every ACM process. */
export async function updateConfig<T>(
  name: string,
  fallback: T,
  update: (current: T) => T | Promise<T>,
): Promise<T> {
  return withConfigUpdateLock(name, async () => {
    const next = await update(await readConfig(name, fallback));
    await writeConfig(name, next);
    return next;
  });
}

/** Integrity-sensitive read-modify-write under the same cross-process lock. */
export async function updateConfigStrict<T>(
  name: string,
  fallback: T,
  parse: (value: unknown) => T | null,
  update: (current: T) => T | Promise<T>,
): Promise<T> {
  return withConfigUpdateLock(name, async () => {
    const next = await update(await readConfigStrict(name, fallback, parse));
    await writeConfig(name, next);
    return next;
  });
}
