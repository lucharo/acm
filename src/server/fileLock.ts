import {
  mkdir,
  open,
  lstat,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

interface FileLockOwner {
  version: 1;
  token: string;
  pid: number;
  createdAt: number;
}

interface LockIdentity {
  dev: number;
  ino: number;
  mtimeMs: number;
  directory: boolean;
  file: boolean;
}

export interface FileUpdateLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  staleMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  writeOwnerFile?: (path: string, contents: string) => Promise<void>;
}

const OWNER_FILE = "owner.json";
const TAKEOVER_FILE = "takeover.json";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 10;
const DEFAULT_STALE_MS = 30_000;

export function documentUpdateLockPath(docPath: string): string {
  const path = resolve(docPath);
  return join(dirname(path), ".acm", "locks", `${basename(path)}.write.lock`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseOwner(value: unknown): FileLockOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const owner = value as Partial<FileLockOwner>;
  return owner.version === 1 &&
    typeof owner.token === "string" &&
    owner.token.length > 0 &&
    typeof owner.pid === "number" &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.createdAt === "number" &&
    Number.isFinite(owner.createdAt)
    ? (owner as FileLockOwner)
    : null;
}

async function readOwner(lockPath: string, file = OWNER_FILE): Promise<FileLockOwner | null> {
  let contents: string;
  try {
    contents = await readFile(join(lockPath, file), "utf8");
  } catch (error) {
    // Only a missing file means "no owner": one we cannot read may name a live holder.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return parseOwner(JSON.parse(contents) as unknown);
  } catch {
    return null;
  }
}

async function lockIdentity(lockPath: string): Promise<LockIdentity | null> {
  try {
    const value = await lstat(lockPath);
    return {
      dev: value.dev,
      ino: value.ino,
      mtimeMs: value.mtimeMs,
      directory: value.isDirectory(),
      file: value.isFile(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameIdentity(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function parseLegacyLockPid(contents: string): number | null {
  const match = /^\s*(\d+)(?:\s|$)/.exec(contents);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function readLegacyLockPid(path: string): Promise<number | null> {
  try {
    return parseLegacyLockPid(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function legacyLockIsReclaimable(
  identity: LockIdentity,
  pid: number | null,
  staleMs: number,
  isProcessAlive: (pid: number) => boolean,
): boolean {
  return Date.now() - identity.mtimeMs > staleMs || (pid !== null && !isProcessAlive(pid));
}

async function removeFileIfOwned(lockPath: string, file: string, token: string): Promise<void> {
  const entry = await readOwner(lockPath, file);
  if (entry?.token !== token) return;
  try {
    await unlink(join(lockPath, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** A claimer that crashed never removes its claim. Its slot stays and the next
 * contender exclusively creates the following one: deleting it instead would race
 * with a rival's fresh claim, and every slot leaves with the lock directory. */
function takeoverSlot(generation: number): string {
  return generation === 0 ? TAKEOVER_FILE : `takeover.${generation}.json`;
}

async function claimIsAbandoned(
  lockPath: string,
  file: string,
  staleMs: number,
  isProcessAlive: (pid: number) => boolean,
): Promise<boolean> {
  const claim = await readOwner(lockPath, file);
  if (claim) return !isProcessAlive(claim.pid);
  // Unparseable: the claimer died between creating the file and writing it, or is
  // about to write it, so only age can tell.
  const identity = await lockIdentity(join(lockPath, file));
  return identity !== null && Date.now() - identity.mtimeMs > staleMs;
}

async function tryTakeOverDeadLock(
  lockPath: string,
  observedIdentity: LockIdentity,
  observedOwner: FileLockOwner | null,
  staleMs: number,
  isProcessAlive: (pid: number) => boolean,
): Promise<boolean> {
  const token = crypto.randomUUID();
  const claim: FileLockOwner = {
    version: 1,
    token,
    pid: process.pid,
    createdAt: Date.now(),
  };
  let claimFile = TAKEOVER_FILE;
  for (let generation = 0; ; generation += 1) {
    claimFile = takeoverSlot(generation);
    const claimPath = join(lockPath, claimFile);
    let claimCreated = false;
    try {
      const handle = await open(claimPath, "wx");
      claimCreated = true;
      try {
        await handle.writeFile(JSON.stringify(claim));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (claimCreated) {
        try {
          await unlink(claimPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await claimIsAbandoned(lockPath, claimFile, staleMs, isProcessAlive))) return false;
    }
  }

  let moved = false;
  try {
    const currentIdentity = await lockIdentity(lockPath);
    if (!currentIdentity || !sameIdentity(currentIdentity, observedIdentity)) return false;
    const currentOwner = await readOwner(lockPath);
    if (currentOwner?.token !== observedOwner?.token) return false;
    const reclaimable = currentOwner
      ? !isProcessAlive(currentOwner.pid)
      : Date.now() - observedIdentity.mtimeMs > staleMs;
    if (!reclaimable) return false;

    const stalePath = `${lockPath}.stale-${token}`;
    await rename(lockPath, stalePath);
    moved = true;
    await rm(stalePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    if (!moved) await removeFileIfOwned(lockPath, claimFile, token);
  }
}

async function tryTakeOverLegacyFileLock(
  lockPath: string,
  observedIdentity: LockIdentity,
  observedPid: number | null,
  label: string,
  timeoutMs: number,
  pollMs: number,
  staleMs: number,
  isProcessAlive: (pid: number) => boolean,
): Promise<boolean> {
  return withFileUpdateLock(
    `${lockPath}.migration`,
    `legacy ${label} lock migration`,
    async () => {
      const currentIdentity = await lockIdentity(lockPath);
      if (
        !currentIdentity?.file ||
        !sameIdentity(currentIdentity, observedIdentity)
      ) {
        return false;
      }
      const currentPid = await readLegacyLockPid(lockPath);
      if (currentPid !== observedPid) return false;
      if (currentPid === null && currentIdentity.mtimeMs !== observedIdentity.mtimeMs) {
        return false;
      }
      const reclaimable = legacyLockIsReclaimable(
        currentIdentity,
        currentPid,
        staleMs,
        isProcessAlive,
      );
      if (!reclaimable) return false;

      const stalePath = `${lockPath}.stale-${crypto.randomUUID()}`;
      await rename(lockPath, stalePath);
      await rm(stalePath, { recursive: true, force: true });
      return true;
    },
    { timeoutMs, pollMs, staleMs },
  );
}

async function releaseOwnedLock(
  lockPath: string,
  identity: LockIdentity,
  token: string,
): Promise<void> {
  const currentIdentity = await lockIdentity(lockPath);
  if (!currentIdentity || !sameIdentity(currentIdentity, identity)) return;
  const owner = await readOwner(lockPath);
  if (owner?.token !== token) return;
  const releasePath = `${lockPath}.release-${token}`;
  await rename(lockPath, releasePath);
  await rm(releasePath, { recursive: true, force: true });
}

/** Serialize one filesystem mutation across ACM processes. The lock is a directory
 * with an ownership token; only its owner may release it. A dead owner is reclaimed
 * through one exclusive takeover claim so contenders cannot unlink a replacement. */
export async function withFileUpdateLock<T>(
  lockPath: string,
  label: string,
  run: () => Promise<T>,
  options: FileUpdateLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const writeOwnerFile = options.writeOwnerFile ?? ((path: string, contents: string) =>
    writeFile(path, contents, { flag: "wx" }));
  const token = crypto.randomUUID();
  const owner: FileLockOwner = {
    version: 1,
    token,
    pid: process.pid,
    createdAt: Date.now(),
  };
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let acquiredIdentity: LockIdentity | null = null;

  while (!acquiredIdentity) {
    try {
      await mkdir(lockPath);
      const setupIdentity = await lockIdentity(lockPath);
      if (!setupIdentity?.directory) {
        throw new Error(`ACM ${label} lock disappeared during setup`);
      }
      try {
        await writeOwnerFile(join(lockPath, OWNER_FILE), JSON.stringify(owner));
        const currentIdentity = await lockIdentity(lockPath);
        if (!currentIdentity || !sameIdentity(currentIdentity, setupIdentity)) {
          await removeFileIfOwned(lockPath, OWNER_FILE, token);
          throw new Error(`ACM ${label} lock changed owner during setup`);
        }
        acquiredIdentity = currentIdentity;
      } catch (error) {
        // Do not remove the shared path after setup failure: another process may
        // already have replaced it. The ownerless directory is recoverable through
        // the guarded stale-lock takeover path.
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observedIdentity = await lockIdentity(lockPath);
      if (observedIdentity?.directory) {
        const observedOwner = await readOwner(lockPath);
        const reclaimable = observedOwner
          ? !isProcessAlive(observedOwner.pid)
          : Date.now() - observedIdentity.mtimeMs > staleMs;
        if (
          reclaimable &&
          (await tryTakeOverDeadLock(
            lockPath,
            observedIdentity,
            observedOwner,
            staleMs,
            isProcessAlive,
          ))
        ) {
          continue;
        }
      } else if (observedIdentity?.file) {
        const observedPid = await readLegacyLockPid(lockPath);
        const reclaimable = legacyLockIsReclaimable(
          observedIdentity,
          observedPid,
          staleMs,
          isProcessAlive,
        );
        if (
          reclaimable &&
          (await tryTakeOverLegacyFileLock(
            lockPath,
            observedIdentity,
            observedPid,
            label,
            timeoutMs,
            pollMs,
            staleMs,
            isProcessAlive,
          ))
        ) {
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to update ACM ${label} (${lockPath})`);
      }
      await Bun.sleep(pollMs);
    }
  }

  try {
    return await run();
  } finally {
    await releaseOwnedLock(lockPath, acquiredIdentity, token);
  }
}
