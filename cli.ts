#!/usr/bin/env bun
// ── acm — the ACM command-line entry ──────────────────────────────────────────
// `acm <file.md>`  opens (creating if missing) a CriticMarkup doc in the editor.
// `acm`            opens a new untitled doc (in-app open screen is a follow-up).
//
// The doc is chosen EXPLICITLY here — no ACM_DOC env indirection — so two sessions
// can't silently diverge onto different copies. Serves the prebuilt SPA from the
// install's ./dist (run `bun run build` once for source/`bun link` use; the
// compiled binary embeds it).

import { existsSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { startServer } from "./server";
import { isAgentVerb, runAgentVerb } from "./src/cli/verbs";
// @ts-ignore — Bun inlines this file's text (and embeds it in the standalone binary).
import SKILL_TEXT from "./skills/acm-review/SKILL.md" with { type: "text" };

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
  acm skill          Install the agent-review skill (~/.claude + ~/.agents)

Agent verbs (doc resolution: --doc <file.md> > $ACM_DOC > the doc open in the
running ACM editor; snapshot before every write):
  acm threads [--json]              List threads: anchor, authors, count, [SUGGEST]
  acm comment "<phrase>" "<text>"   Reply to the thread matching <phrase>
  acm suggest "<span>" "<new>"      Anchor a SUGGEST: on the unique prose <span>
  acm accept "<phrase>"             Accept the suggestion matching <phrase>
  acm reject "<phrase>"             Reject it (keep the original span)
  acm resolve "<phrase>"            Strip the thread matching <phrase>
  acm apply <edits.json>            Batch reply-append (idempotent); [{id,match,insert}]
  acm wrap [width]                  Hard-wrap prose (default 88); markup-safe
  acm heal                          Repair markup that renders raw; snapshot-first
  acm import <file.docx> [out.md]   Word → CriticMarkup .md (needs the converter)
  acm spell [list] [--json]         List flagged words: count, suggestions, line
  acm spell add <word…>             Keep words in your personal dictionary
  acm spell replace "<w>" "<fix>"   Fix every flagged <w> in the doc (case-preserving)
  acm history [n]                   The doc's version journal (auto-recorded)
  acm restore <sha>                 Restore a journal version (snapshots first)
    (verbs take --doc <file>, --author <name>; matching fails safe on ambiguity)

Options:
  --port <n>         Port to serve on (default 12000; auto-increments if busy)
  --no-open          Don't auto-open the browser
  -h, --help         Show this help`);
}

/** Install the bundled agent-review skill. The real (editable) copy lives under
 *  ~/.agents/skills/acm-review; ~/.claude/skills/acm-review is a symlink to it.
 *  Never overwrites an existing copy — the skill is pure preference, no updates. */
function installSkill() {
  const agentsDir = join(homedir(), ".agents", "skills", "acm-review");
  const agentsFile = join(agentsDir, "SKILL.md");
  mkdirSync(agentsDir, { recursive: true });
  if (existsSync(agentsFile)) {
    console.log(`acm: skill already present (keeping your edits): ${agentsFile}`);
  } else {
    writeFileSync(agentsFile, SKILL_TEXT);
    console.log(`acm: installed agent-review skill → ${agentsFile}`);
  }
  const claudeSkills = join(homedir(), ".claude", "skills");
  const claudeLink = join(claudeSkills, "acm-review");
  try {
    mkdirSync(claudeSkills, { recursive: true });
    if (!existsSync(claudeLink)) {
      symlinkSync(agentsDir, claudeLink);
      console.log(`acm: linked → ${claudeLink}`);
    } else {
      console.log(`acm: ~/.claude skill already present: ${claudeLink}`);
    }
  } catch (e) {
    console.log(`acm: could not link into ~/.claude/skills — ${(e as Error).message}`);
  }
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

// Subcommands.
if (process.argv[2] === "skill") {
  installSkill();
  process.exit(0);
}
// Agent edit/read verbs (threads/comment/suggest/accept/reject/resolve/apply/spell).
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
