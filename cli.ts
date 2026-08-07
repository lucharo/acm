#!/usr/bin/env bun
// ── acm — the ACM command-line entry ──────────────────────────────────────────
// `acm` explains the tool. `acm edit` opens the document launcher, while
// `acm edit <file.md>` opens one explicitly named Markdown document. Agent verbs
// remain top-level because they operate on the document already open in ACM.

import { resolve } from "node:path";
import { startServer } from "./server";
import { HELP_TEXT, OVERVIEW_TEXT, parseInvocation } from "./src/cli/invocation";
import { isAgentVerb, runAgentVerb } from "./src/cli/verbs";
import { prepareDocumentTarget } from "./src/server/documentTarget";
import { startLauncherServer } from "./src/server/launcher";
import { recordRecentDocument } from "./src/server/recent";

function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // The URL is always printed, so a missing desktop opener is non-fatal.
  }
}

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
if (invocation.kind === "error") {
  console.error(invocation.message);
  process.exit(2);
}
if (invocation.kind === "legacy-skill") {
  console.error("`acm skill` has been replaced by the standard skills manager.");
  console.error("From the ACM repository, run `bun run setup` to install or refresh acm-review.");
  console.error("That setup delegates agent paths and symlinks to `npx skills add`.");
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
const rememberRecentDocument = async (documentPath: string) => {
  if (await recordRecentDocument(documentPath)) return;
  console.error(
    "acm edit: warning: could not update Recent Documents; the editor remains available.",
  );
};

try {
  if (invocation.file) {
    const target = prepareDocumentTarget(invocation.file, process.cwd(), "open-or-create");
    if (!target.ok) {
      console.error(`acm edit: ${target.message}`);
      process.exit(2);
    }
    const acm = startOnFreePort(preferredPort, (port) =>
      startServer({ docPath: target.path, port, ...assets }),
    );
    await rememberRecentDocument(target.path);
    const url = `http://localhost:${acm.port}`;
    if (target.created) console.log(`Created new document: ${target.path}`);
    console.log(`\n  ACM ready → ${url}\n  editing: ${target.path}\n`);
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
            startServer({ docPath: documentPath, port: documentPort, ...assets }),
          );
          await rememberRecentDocument(documentPath);
          setTimeout(() => launcher.stop(), 750);
          return { url: `http://localhost:${acm.port}` };
        },
      }),
    );
    const url = `http://localhost:${launcher.port}`;
    console.log(`\n  ACM launcher → ${url}\n  folder: ${launcher.cwd}\n`);
    if (invocation.open) openBrowser(url);
  }
} catch (error) {
  console.error(`acm edit: ${(error as Error).message}`);
  process.exit(1);
}
