// ── acm edit <file.md> --notify | --wait (#31) ────────────────────────────────
// An agent listens to the editor for work the person hands it. Stdout carries only
// wake lines, so a line-watcher (Claude Code's Monitor tool) wakes the agent on each;
// everything else goes to stderr. When an editor is already open on the document,
// the CLI attaches to it (GET /api/agent/events) instead of starting a second one,
// so the clicks in the page the person is using reach the agent.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { liveInstances, probeInstanceState, type InstanceEntry } from "../server/instances";

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

/** The live editor serving `docPath`, if any (never the review-preferences one). */
export async function findEditorFor(docPath: string): Promise<InstanceEntry | undefined> {
  for (const entry of await liveInstances()) {
    if (entry.auxiliary || !samePath(entry.doc, docPath)) continue;
    if ((await probeInstanceState(entry)) === "live") return entry;
  }
  return undefined;
}

/** Print the editor's wake lines to stdout. `once` (--wait) returns 0 after the
 *  first answer; otherwise it streams until the editor goes away. A stream that
 *  ends without work prints an `acm: closed` line, so a watcher is never left silent,
 *  and returns 1. */
export async function listenToEditor(
  port: number,
  once: boolean,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const url = `http://127.0.0.1:${port}/api/agent/events${once ? "?wait=1" : ""}`;
  let printed = 0;
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) {
          write(line);
          printed += 1;
        }
        newline = buffer.indexOf("\n");
      }
    }
  } catch {
    // the editor went away mid-stream: reported below
  }
  if (once && printed > 0) return 0;
  write(`acm: closed the editor at http://localhost:${port} stopped; run acm edit again to keep listening`);
  return 1;
}

/** The argv that re-runs this CLI: the compiled binary alone, or bun plus cli.ts. */
function selfCommand(): string[] {
  const script = process.argv[1] ?? "";
  const compiled = script.startsWith("/$bunfs/") || script.includes("~BUN");
  return compiled ? [process.execPath] : [process.execPath, script];
}

/** Start a detached editor on `docPath` that outlives this process (--wait with no
 *  editor open), then wait for it to register. */
export async function startDetachedEditor(docPath: string, editArgs: string[]): Promise<InstanceEntry> {
  const [command, ...prefix] = selfCommand();
  const child = spawn(command, [...prefix, "edit", docPath, ...editArgs], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const entry = (await liveInstances()).find((e) => e.pid === child.pid && samePath(e.doc, docPath));
    if (entry && (await probeInstanceState(entry)) === "live") return entry;
    if (child.exitCode !== null) break;
    await Bun.sleep(100);
  }
  throw new Error("the editor did not start; run acm edit <file.md> to see why");
}
