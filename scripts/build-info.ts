// Read the build's origin from the environment and git at build time (vite.config.ts,
// scripts/build-bin.ts) or, in source mode, when the CLI runs (#55). Node's
// child_process, not Bun.spawnSync: vite.config.ts runs under Node.
import { execFileSync } from "node:child_process";
import { describeBuild, type BuildInfo, type GitState } from "../src/buildInfo";

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).toString().trim();
  } catch {
    return null;
  }
}

export function gitState(root: string): GitState | null {
  const commit = git(root, ["rev-parse", "--short", "HEAD"]);
  if (!commit) return null;
  const ref = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  return { ref: ref && ref !== "HEAD" ? ref : null, commit, dirty: !!status };
}

export function currentBuildInfo(root: string): BuildInfo {
  return describeBuild(process.env, gitState(root));
}
