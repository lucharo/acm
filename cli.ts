#!/usr/bin/env bun
// ── acm — the ACM command-line entry ──────────────────────────────────────────
// `acm` explains the tool. `acm edit` opens the document launcher, while
// `acm edit <file.md>` opens one explicitly named Markdown document. Agent verbs
// remain top-level because they operate on the document already open in ACM.

import { resolve } from "node:path";
import { startServer } from "./server";
import { resolveAllowedHosts } from "./src/server/http";
import { tailscaleDnsName } from "./src/server/tailscale";
import { openBrowser } from "./src/server/browserOpen";
import { HELP_TEXT, OVERVIEW_TEXT, parseInvocation } from "./src/cli/invocation";
import { isAgentVerb, runAgentVerb } from "./src/cli/verbs";
import { ACM_VERSION } from "./src/version";
import { prepareDocumentTarget } from "./src/server/documentTarget";
import { startLauncherServer } from "./src/server/launcher";
import { recordRecentDocument } from "./src/server/recent";
import { findUserReviewSkill, NO_REVIEW_PREFERENCES } from "./src/server/reviewSkill";
import { findEditorFor, listenToEditor, startDetachedEditor } from "./src/cli/agentListen";

function isBusyPort(error: unknown): boolean {
  return (error as { code?: string })?.code === "EADDRINUSE";
}

function startOnFreePort<T>(preferredPort: number, start: (port: number) => T): T {
  let port = preferredPort;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return start(port);
    } catch (error) {
      if (!isBusyPort(error)) throw error;
      port += 1;
    }
  }
  throw new Error("could not find a free port to listen on");
}

async function loadStaticAssets(): Promise<{
  staticDir: string;
  staticAssets?: Map<string, string>;
}> {
  let staticAssets: Map<string, string> | undefined;
  try {
    const mod = await import("./src/server/embedded.generated");
    staticAssets = mod.EMBEDDED_ASSETS as Map<string, string>;
  } catch {
    // Source mode uses the filesystem build in ./dist.
  }
  return { staticDir: resolve(import.meta.dir, "dist"), staticAssets };
}

const invocation = parseInvocation(process.argv.slice(2), isAgentVerb);

if (invocation.kind === "overview") {
  console.log(OVERVIEW_TEXT);
  process.exit(0);
}
if (invocation.kind === "help") {
  console.log(HELP_TEXT);
  process.exit(0);
}
if (invocation.kind === "version") {
  console.log(`acm ${ACM_VERSION}`);
  process.exit(0);
}
if (invocation.kind === "verb-help") {
  console.log(invocation.text);
  process.exit(0);
}
if (invocation.kind === "error") {
  console.error(invocation.message);
  process.exit(2);
}
if (invocation.kind === "agent") {
  try {
    const { setEmbeddedDicts } = await import("./src/cli/spellEngine");
    const dicts = await import("./src/cli/dicts.generated");
    setEmbeddedDicts(dicts.EMBEDDED_DICTS);
  } catch {
    // Source mode resolves dictionaries from node_modules.
  }
  await runAgentVerb(invocation.verb, invocation.args);
  process.exit(0);
}

const assets = await loadStaticAssets();
const preferredPort = invocation.port ?? 12000;
const assetRootRaw = invocation.assetRoot ?? (process.env.ACM_ASSET_ROOT?.trim() || undefined);
const assetRootArg = assetRootRaw ? resolve(assetRootRaw) : undefined;
const allowedHosts = resolveAllowedHosts({
  flags: invocation.allowHosts ?? [],
  env: process.env.ACM_ALLOWED_HOSTS,
  detect: tailscaleDnsName,
});
const remoteLine = allowedHosts.length ? `\n  also allowed: ${allowedHosts.join(", ")}` : "";
const rememberRecentDocument = async (documentPath: string) => {
  if (await recordRecentDocument(documentPath)) return;
  console.error(
    "acm edit: warning: could not update Recent Documents; the editor remains available.",
  );
};

try {
  if (invocation.reviewSkill) {
    const skill = findUserReviewSkill();
    if (!skill) {
      console.log(NO_REVIEW_PREFERENCES);
      process.exit(0);
    }
    invocation.file = skill;
  }
  if (invocation.file) {
    const target = prepareDocumentTarget(invocation.file, process.cwd(), "open-or-create");
    if (!target.ok) {
      console.error(`acm edit: ${target.message}`);
      process.exit(2);
    }
    // --notify / --wait (#31): stdout is for wake lines only, so the rest goes to stderr.
    const say = invocation.listen ? console.error : console.log;
    if (invocation.listen) {
      // Attach to an editor already open on this document, so the person's clicks in
      // that page reach the agent; --wait starts one that outlives it if none is open.
      let editor = await findEditorFor(target.path);
      if (!editor && invocation.listen === "wait") {
        const editArgs = [
          ...(invocation.open ? [] : ["--no-open"]),
          ...(invocation.port !== undefined ? ["--port", String(invocation.port)] : []),
          ...(invocation.assetRoot ? ["--asset-root", invocation.assetRoot] : []),
          ...(invocation.allowHosts ?? []).flatMap((host) => ["--allow-host", host]),
        ];
        editor = await startDetachedEditor(target.path, editArgs);
      }
      if (editor) {
        say(`\n  ACM listening to the editor at http://localhost:${editor.port}\n  editing: ${target.path}\n`);
        process.exit(await listenToEditor(editor.port, invocation.listen === "wait"));
      }
    }
    const acm = startOnFreePort(preferredPort, (port) =>
      startServer({
        docPath: target.path,
        port,
        assetRoot: assetRootArg,
        allowedHosts,
        ...assets,
        ...(invocation.listen === "notify"
          ? { onWakeLine: (line: string) => process.stdout.write(`${line}\n`), log: console.error }
          : {}),
      }),
    );
    await rememberRecentDocument(target.path);
    const url = `http://localhost:${acm.port}`;
    if (target.created) say(`Created new document: ${target.path}`);
    say(`\n  ACM ready → ${url}\n  editing: ${target.path}${remoteLine}\n`);
    if (invocation.open) openBrowser(url);
  } else {
    let launcher: ReturnType<typeof startLauncherServer>;
    launcher = startOnFreePort(preferredPort, (port) =>
      startLauncherServer({
        port,
        cwd: process.cwd(),
        ...assets,
        activateDocument: async (documentPath) => {
          const documentStartPort = launcher.port < 65_535 ? launcher.port + 1 : 0;
          const acm = startOnFreePort(documentStartPort, (documentPort) =>
            startServer({ docPath: documentPath, port: documentPort, assetRoot: assetRootArg, allowedHosts, ...assets }),
          );
          await rememberRecentDocument(documentPath);
          setTimeout(() => launcher.stop(), 750);
          return { url: `http://localhost:${acm.port}` };
        },
      }),
    );
    const url = `http://localhost:${launcher.port}`;
    console.log(`\n  ACM launcher → ${url}\n  folder: ${launcher.cwd}${remoteLine}\n`);
    if (invocation.open) openBrowser(url);
  }
} catch (error) {
  console.error(`acm edit: ${(error as Error).message}`);
  process.exit(1);
}
