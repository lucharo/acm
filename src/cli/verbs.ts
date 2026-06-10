// ── acm agent verbs (CLI layer) ────────────────────────────────────────────────
// The blessed surface for agents to edit a doc from the shell — thin wrappers over
// the pure core in lib/agentEdits, adding the I/O envelope every mutating verb needs:
//   read → SNAPSHOT (safety net) → transform → write → VERIFY (re-parse + report).
// Anchoring is by unique text match (offset-safe, fails on ambiguity). Direct file
// edits and the HTTP API stay available for one-offs; these verbs are for the common
// review ops so agents don't hand-roll a script per batch.

import { resolve } from "node:path";
import { snapshot } from "../server/snapshot";
import {
  AmbiguityError,
  appendToThread,
  addComment,
  addSuggestion,
  resolveSuggestion,
  resolveSuggestionGroup,
  resolveThread,
  threadsSummary,
} from "../lib/agentEdits";
import { scanTokens, applicableSuggestionIds, hardWrap, validateMarkup, healDocument } from "../lib/criticmarkup";

const VERBS = new Set(["apply", "comment", "suggest", "accept", "reject", "resolve", "threads", "wrap", "import", "heal"]);
export function isAgentVerb(cmd?: string): boolean {
  return !!cmd && VERBS.has(cmd);
}

interface Flags {
  doc?: string;
  author?: string;
  group?: string;
  json: boolean;
  positional: string[];
}
function parseFlags(argv: string[]): Flags {
  const f: Flags = { json: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--doc") f.doc = argv[++i];
    else if (a === "--author") f.author = argv[++i];
    else if (a === "--group") f.group = argv[++i];
    else if (a === "--json") f.json = true;
    else f.positional.push(a);
  }
  return f;
}
function docPathFrom(f: Flags): string {
  const p = f.doc ?? process.env.ACM_DOC;
  if (!p) {
    console.error("acm: no document — pass --doc <file.md> or set ACM_DOC");
    process.exit(1);
  }
  return resolve(p);
}

export async function runAgentVerb(cmd: string, argv: string[]): Promise<void> {
  const f = parseFlags(argv);
  const author = f.author ?? process.env.ACM_AUTHOR ?? "claude";

  // ── Import: docx → CriticMarkup .md — the ONE verb that needs no ACM_DOC ────
  if (cmd === "import") {
    await runImport(f);
    return;
  }

  const docPath = docPathFrom(f);

  // ── Read-only verb ──────────────────────────────────────────────────────────
  if (cmd === "threads") {
    const content = await Bun.file(docPath).text();
    const summary = threadsSummary(content);
    if (f.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    for (const t of summary) {
      const anchor = t.anchor ? `⟦${t.anchor.slice(0, 40)}⟧ ` : "";
      console.log(`#${t.id} (${t.count}) @${t.authors.join(" @")}${t.applicable ? " [SUGGEST]" : ""}  ${anchor}${t.preview}`);
    }
    console.log(`\n${summary.length} threads`);
    return;
  }

  // ── Mutating verbs: snapshot → transform → write → verify ─────────────────────
  const before = await Bun.file(docPath).text();
  let after: string;
  let note: string;
  try {
    switch (cmd) {
      case "apply": {
        const editsPath = f.positional[0];
        if (!editsPath) throw new Error("usage: acm apply <edits.json> [--doc <file>]");
        const edits = JSON.parse(await Bun.file(resolve(editsPath)).text()) as {
          id: string;
          match: string;
          insert: string;
        }[];
        let content = before;
        const applied: string[] = [];
        const skipped: string[] = [];
        const errors: string[] = [];
        for (const e of edits) {
          try {
            const r = appendToThread(content, e.match, e.insert); // re-scans each time → offsets fresh
            content = r.content;
            (r.skipped ? skipped : applied).push(e.id);
          } catch (err) {
            errors.push(`${e.id}: ${(err as Error).message}`);
          }
        }
        after = content;
        note = `applied ${applied.length}/${edits.length}, skipped ${skipped.length} (idempotent), errors ${errors.length}`;
        if (errors.length) note += "\n  ✗ " + errors.join("\n  ✗ ");
        if (applied.length) note += `\n  applied: ${applied.join(", ")}`;
        break;
      }
      case "comment": {
        const [phrase, text] = f.positional;
        if (!phrase || !text) throw new Error('usage: acm comment "<phrase>" "<text>" [--doc] [--author]');
        after = addComment(before, phrase, author, text);
        note = `replied to "${phrase.slice(0, 40)}" as @${author}`;
        break;
      }
      case "suggest": {
        const [span, replacement] = f.positional;
        if (!span || replacement === undefined)
          throw new Error('usage: acm suggest "<span>" "<new wording>" [--group <id>] [--doc] [--author]');
        after = addSuggestion(before, span, author, replacement, f.group);
        note = `SUGGEST${f.group ? `[g:${f.group}]` : ""} anchored on "${span.slice(0, 40)}" as @${author}`;
        break;
      }
      case "accept":
      case "reject": {
        if (f.group) {
          // Whole-group resolution (#21): every member edit lands in ONE write.
          const r = resolveSuggestionGroup(before, f.group, cmd);
          after = r.content;
          note = `${cmd}ed suggestion group "${f.group}" — ${r.applied} edits${r.skipped ? `, ${r.skipped} skipped` : ""}`;
          break;
        }
        const [phrase] = f.positional;
        if (!phrase) throw new Error(`usage: acm ${cmd} "<phrase>" | acm ${cmd} --group <id>  [--doc]`);
        after = resolveSuggestion(before, phrase, cmd);
        note = `${cmd}ed the suggestion matching "${phrase.slice(0, 40)}"`;
        break;
      }
      case "resolve": {
        const [phrase] = f.positional;
        if (!phrase) throw new Error('usage: acm resolve "<phrase>" [--doc]');
        after = resolveThread(before, phrase);
        note = `resolved the thread matching "${phrase.slice(0, 40)}"`;
        break;
      }
      case "heal": {
        // Mechanical repair of markup that renders raw: nested comments, comments
        // trapped in tracked changes, multi-block anchors. Snapshot-first (below).
        const beforeCount = validateMarkup(before).length;
        after = healDocument(before);
        note = `healed ${beforeCount - validateMarkup(after).length} of ${beforeCount} markup issues (${validateMarkup(after).length} remain)`;
        break;
      }
      case "wrap": {
        // Markup-safe prose reflow (vim textwidth analog). Constructs are atomic,
        // so token ids / seen-state survive; structure lines stay verbatim.
        const width = f.positional[0] ? Number(f.positional[0]) : 88;
        if (!Number.isFinite(width) || width < 20) throw new Error("usage: acm wrap [width≥20] [--doc]");
        after = hardWrap(before, width);
        note = `hard-wrapped prose to ${width} columns`;
        break;
      }
      default:
        throw new Error(`unknown verb: ${cmd}`);
    }
  } catch (err) {
    console.error(`acm ${cmd}: ${(err as AmbiguityError).message}`);
    process.exit(1);
  }

  if (after === before) {
    console.log(`acm ${cmd}: no change. ${note}`);
    return;
  }
  const snap = await snapshot(docPath, cmd); // back up the PRE-edit doc
  await Bun.write(docPath, after);

  const toks = scanTokens(after);
  const comments = toks.filter((t) => t.type === "comment").length;
  console.log(`acm ${cmd}: ${note}`);
  if (snap) console.log(`  backup → ${snap}`);
  console.log(`  comments: ${comments} | applicable SUGGEST cards: ${applicableSuggestionIds(after, toks).size}`);
}

// ── acm import <file.docx> [out.md] — docx → CriticMarkup via the converter ───
// The validated converter (uv single-file script, stdlib only) lives outside this
// repo alongside its adversarial validation harness; point ACM_CONVERTER at a
// different copy if yours is elsewhere.
async function runImport(f: Flags): Promise<void> {
  const [src, outArg] = f.positional;
  if (!src || !/\.docx$/i.test(src)) {
    console.error("usage: acm import <file.docx> [out.md]");
    process.exit(1);
  }
  const out = resolve(outArg ?? src.replace(/\.docx$/i, ".md"));
  const converter =
    process.env.ACM_CONVERTER ?? `${process.env.HOME}/Projects/acm-seed/convert.py`;
  if (!(await Bun.file(converter).exists())) {
    console.error(`acm import: converter not found at ${converter} — set ACM_CONVERTER`);
    process.exit(1);
  }
  const proc = Bun.spawn(["uv", "run", converter, resolve(src), out], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) process.exit(1);
  const content = await Bun.file(out).text();
  const diags = validateMarkup(content);
  console.log(`acm import: ${out}`);
  console.log(
    `  markup diagnostics: ${diags.length === 0 ? "0 (clean)" : `${diags.length} — open in ACM and click Review`}`,
  );
}
