#!/usr/bin/env bun
// ── acm — the ACM command-line entry ──────────────────────────────────────────
// `acm <file.md>`  opens (creating if missing) a CriticMarkup doc in the editor.
// `acm`            opens a new untitled doc (in-app open screen is a follow-up).
//
// The doc is chosen EXPLICITLY here — no ACM_DOC env indirection — so two sessions
// can't silently diverge onto different copies. Serves the prebuilt SPA from the
// checkout's ./dist in source mode; the installed standalone binary embeds it.

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startServer } from "./server";
import { isAgentVerb, runAgentVerb } from "./src/cli/verbs";

interface Args {
  file?: string;
  port?: number;
  open: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") out.open = false;
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith("-") && out.file === undefined) {
      out.file = a;
    }
  }
  return out;
}

function printHelp() {
  console.log(`acm — Agent CriticMarkup editor

Usage:
  acm [file.md]      Open (creating if missing) a CriticMarkup document
  acm                Open a new untitled document

Agent verbs (doc resolution: --doc <file.md> > $ACM_DOC > the doc open in the
running ACM editor; snapshot before every write):
  acm threads [--json]              List threads: anchor, authors, count, [SUGGEST]
  acm reply "<phrase>" "<text>"     Reply to the thread matching <phrase> (alias: comment)
  acm suggest "<span>" "<new>"      Anchor a SUGGEST: on the unique prose <span>
  acm accept "<phrase>"             Accept the suggestion matching <phrase>
  acm reject "<phrase>"             Reject it (keep the original span)
  acm resolve "<phrase>"            Strip the thread matching <phrase>
  acm reply --batch <edits.json>    Batch reply-append (idempotent); [{id,match,insert}]
  acm wrap [width]                  Hard-wrap prose (default 88); markup-safe
  acm heal                          Repair markup that renders raw; snapshot-first
  acm import <Google Docs URL|file.docx> [out.md]
                                     Google Docs/Word → CriticMarkup, including comments
  acm spell [list] [--json]         List flagged words: count, suggestions, line
  acm spell add <word…>             Keep words in your personal dictionary
  acm spell ignore <word…>          Stop flagging words in THIS doc only
  acm spell replace "<w>" "<fix>"   Fix every flagged <w> in the doc (case-preserving)
  acm history [n]                   The doc's version history (auto-recorded)
  acm restore <sha>                 Restore a history version (snapshots first)
    (verbs take --doc <file>, --author <name>; matching fails safe on ambiguity)

Options:
  --port <n>         Port to serve on (default 12000; auto-increments if busy)
  --no-open          Don't auto-open the browser
  -h, --help         Show this help`);
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // No browser opener available — the URL is printed below regardless.
  }
}

function uniqueUntitled(): string {
  let p = resolve("untitled.md");
  let n = 2;
  while (existsSync(p)) p = resolve(`untitled-${n++}.md`);
  return p;
}

if (process.argv[2] === "skill") {
  console.error("`acm skill` has been replaced by the standard skills manager.");
  console.error("From the ACM repository, run `bun run setup` to install or refresh acm-review.");
  console.error("That setup delegates agent paths and symlinks to `npx skills add`.");
  process.exit(2);
}

// Agent edit/read verbs (threads/reply/comment/suggest/accept/reject/resolve/spell).
if (isAgentVerb(process.argv[2])) {
  // Give `acm spell` its Hunspell dicts when running as the compiled binary (where
  // node_modules isn't beside the executable). The generated module's file-imports
  // are embedded by `bun build --compile`; it's absent in plain source mode, where
  // the catch is a no-op and the engine reads node_modules instead. Resolved here in
  // cli.ts (outside the tsc `include`) so the optional generated module never breaks
  // typecheck — the same arrangement the SPA's embedded.generated uses below.
  try {
    const { setEmbeddedDicts } = await import("./src/cli/spellEngine");
    const dicts = await import("./src/cli/dicts.generated");
    setEmbeddedDicts(dicts.EMBEDDED_DICTS);
  } catch {
    // No generated dicts (source mode) → engine resolves them from node_modules.
  }
  await runAgentVerb(process.argv[2], process.argv.slice(3));
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));

const docPath = args.file ? resolve(args.file) : uniqueUntitled();
if (!existsSync(docPath)) {
  writeFileSync(docPath, "");
  console.log(`Created new document: ${docPath}`);
}

// SPA assets: embedded (compiled binary / built install) if the generated map is
// present, else the filesystem dist next to this file. Both resolve the same way.
let staticAssets: Map<string, string> | undefined;
try {
  const mod = await import("./src/server/embedded.generated");
  staticAssets = mod.EMBEDDED_ASSETS as Map<string, string>;
} catch {
  // Not generated yet (run `bun run build:embed`) — fall back to filesystem dist.
}
const staticDir = resolve(import.meta.dir, "dist");

// Find a free port, starting at the requested/default and incrementing if busy.
let acm: ReturnType<typeof startServer> | undefined;
let port = args.port ?? 12000;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    acm = startServer({ docPath, port, staticDir, staticAssets });
    break;
  } catch {
    port++;
  }
}
if (!acm) {
  console.error("acm: could not find a free port to listen on");
  process.exit(1);
}

const url = `http://localhost:${acm.port}`;
console.log(`\n  ACM ready → ${url}\n  editing: ${docPath}\n`);
if (args.open) openBrowser(url);
