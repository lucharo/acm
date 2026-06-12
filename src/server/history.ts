// ── Doc history: a git shadow journal (#11) ────────────────────────────────────
// Version control for the document WITHOUT a second source of truth: a hidden
// git repo at `<docDir>/.acm/history.git` whose work-tree is the doc directory,
// tracking ONLY the doc file. The user's directory stays clean (no nested .git),
// the .md on disk remains the one truth, and git supplies log/diff/restore for
// free — recoverable bad inserts and an activity timeline, as the issue asked.
//
// Writers: the server records on a quiet-period debounce after saves/external
// writes (see server.ts) plus a baseline at boot. Readers: `acm history` and
// `acm restore <ref>`. Commits are authored as "acm" so no global git identity
// is required.

import { dirname, basename, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { scanTokens, countWords } from "../lib/criticmarkup";

function gitDirFor(docPath: string): string {
  return join(dirname(docPath), ".acm", "history.git");
}

async function git(
  docPath: string,
  args: string[],
): Promise<{ ok: boolean; out: string; raw: string }> {
  const proc = Bun.spawn(
    [
      "git",
      `--git-dir=${gitDirFor(docPath)}`,
      `--work-tree=${dirname(docPath)}`,
      "-c",
      "user.name=acm",
      "-c",
      "user.email=acm@localhost",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  // `out` is trimmed for messages/parsing; `raw` is byte-faithful stdout (restore
  // fidelity — trimming would eat the doc's trailing newline).
  return { ok: code === 0, out: (out + err).trim(), raw: out };
}

/** Make `<docDir>/.acm` invisible to any ENCLOSING git repo: a nested
 *  `.gitignore` containing `*` ignores the whole dir (itself included), so the
 *  journal/snapshots never show up as untracked noise in the user's repo and
 *  nothing in their .gitignore needs editing. The journal itself is unaffected —
 *  every git call passes explicit --git-dir/--work-tree, so an enclosing repo is
 *  never discovered or touched. */
function selfIgnoreAcmDir(acmDir: string): void {
  const ignore = join(acmDir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}

async function ensureRepo(docPath: string): Promise<boolean> {
  const dir = gitDirFor(docPath);
  if (existsSync(dir)) return true;
  mkdirSync(dirname(dir), { recursive: true });
  selfIgnoreAcmDir(dirname(dir));
  const init = await Bun.spawn(["git", "init", "--quiet", "--bare", dir], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  if (init !== 0) return false;
  // A bare repo + explicit --work-tree on every call = no .git in the doc dir
  // and no risk of git treating the user's directory as a checkout.
  await git(docPath, ["config", "core.bare", "false"]);
  return true;
}

/** Commit the doc's current state if it changed. Returns the short SHA of the
 *  new commit, or null when there was nothing to record (or git is unavailable —
 *  history degrades to a no-op rather than breaking saves). */
export async function recordHistory(docPath: string, source: string): Promise<string | null> {
  try {
    if (!(await ensureRepo(docPath))) return null;
    const name = basename(docPath);
    await git(docPath, ["add", "--", name]);
    const status = await git(docPath, ["status", "--porcelain", "--", name]);
    if (!status.ok || status.out === "") return null; // unchanged — nothing to record
    let text = "";
    try {
      text = await Bun.file(docPath).text();
    } catch {
      return null;
    }
    const words = countWords(text);
    const comments = scanTokens(text).filter((t) => t.type === "comment").length;
    const msg = `${source}: ${words} words, ${comments} comments`;
    const commit = await git(docPath, ["commit", "--quiet", "-m", msg]);
    if (!commit.ok) return null;
    const sha = await git(docPath, ["rev-parse", "--short", "HEAD"]);
    return sha.ok ? sha.out : null;
  } catch {
    return null; // never let history-keeping break the save path
  }
}

/** The journal, newest first: `<short-sha>  <relative time>  <message>` lines. */
export async function listHistory(docPath: string, n = 20): Promise<string[]> {
  if (!existsSync(gitDirFor(docPath))) return [];
  const log = await git(docPath, [
    "log",
    `-${n}`,
    "--pretty=format:%h  %ar  %s",
  ]);
  return log.ok && log.out ? log.out.split("\n") : [];
}

/** The doc's content at `ref` (e.g. a short SHA from listHistory), or null. */
export async function showVersion(docPath: string, ref: string): Promise<string | null> {
  if (!existsSync(gitDirFor(docPath))) return null;
  const show = await git(docPath, ["show", `${ref}:${basename(docPath)}`]);
  return show.ok ? show.raw : null;
}
