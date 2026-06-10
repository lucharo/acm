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
  resolveThread,
  threadsSummary,
} from "../lib/agentEdits";
import { scanTokens, applicableSuggestionIds, hardWrap } from "../lib/criticmarkup";

const VERBS = new Set(["apply", "comment", "suggest", "accept", "reject", "resolve", "threads", "wrap"]);
export function isAgentVerb(cmd?: string): boolean {
  return !!cmd && VERBS.has(cmd);
}

interface Flags {
  doc?: string;
  author?: string;
  json: boolean;
  positional: string[];
}
function parseFlags(argv: string[]): Flags {
  const f: Flags = { json: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--doc") f.doc = argv[++i];
    else if (a === "--author") f.author = argv[++i];
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
  const docPath = docPathFrom(f);
  const author = f.author ?? process.env.ACM_AUTHOR ?? "claude";

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
          throw new Error('usage: acm suggest "<span>" "<new wording>" [--doc] [--author]');
        after = addSuggestion(before, span, author, replacement);
        note = `SUGGEST anchored on "${span.slice(0, 40)}" as @${author}`;
        break;
      }
      case "accept":
      case "reject": {
        const [phrase] = f.positional;
        if (!phrase) throw new Error(`usage: acm ${cmd} "<phrase>" [--doc]`);
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
