// ── acm agent verbs (CLI layer) ────────────────────────────────────────────────
// The blessed surface for agents to edit a doc from the shell — thin wrappers over
// the pure core in lib/agentEdits, adding the I/O envelope every mutating verb needs:
//   read → SNAPSHOT (safety net) → transform → write → VERIFY (re-parse + report).
// Anchoring is by unique text match (offset-safe, fails on ambiguity). Direct file
// edits and the HTTP API stay available for one-offs; these verbs are for the common
// review ops so agents don't hand-roll a script per batch.

import { resolve } from "node:path";
import { snapshot } from "../server/snapshot";
import { liveInstances, probeInstanceState, isConnectionRefused } from "../server/instances";
import { listHistory, showVersion, recordHistory } from "../server/history";
import { readConfig, writeConfig } from "../server/config";
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
import { loadSpellEngine } from "./spellEngine";
import type { SpellEngine } from "./spellEngine";
import type { SpellVariant } from "../lib/viewSettings";

const VERBS = new Set(["reply", "apply", "comment", "suggest", "accept", "reject", "resolve", "threads", "wrap", "import", "heal", "history", "restore", "spell"]);
export function isAgentVerb(cmd?: string): boolean {
  return !!cmd && VERBS.has(cmd);
}

interface Flags {
  doc?: string;
  author?: string;
  group?: string;
  batch?: string;
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
    else if (a === "--batch") f.batch = argv[++i];
    else if (a === "--json") f.json = true;
    else f.positional.push(a);
  }
  return f;
}
async function docPathFrom(f: Flags): Promise<string> {
  const p = f.doc ?? process.env.ACM_DOC;
  if (p) return resolve(p);
  // No explicit doc → the one open in the running editor (instance registry).
  // Exactly one live instance resolves; several is ambiguous — never guess.
  // Probe each candidate's port too: a recycled PID can impersonate a dead
  // server, but it won't answer /api/doc. An UNREACHABLE candidate (probe timed
  // out — possibly alive but slow) makes resolution ambiguous the same way a
  // second live editor does: dropping it could pick the WRONG document.
  const registered = await liveInstances();
  const states = await Promise.all(registered.map(probeInstanceState));
  const unreachable = registered.filter((_, i) => states[i] === "unreachable");
  if (unreachable.length > 0) {
    console.error("acm: an ACM editor did not answer its port (busy machine?) — pass --doc <file.md> rather than guessing:");
    for (const e of unreachable) console.error(`  :${e.port} → ${e.doc} (unreachable)`);
    console.error("  (if an editor is actually gone, remove its entry from ~/.config/acm/instances.json)");
    process.exit(1);
  }
  const live = registered.filter((_, i) => states[i] === "live");
  if (live.length === 1) {
    console.error(`acm: using ${live[0].doc} (open in ACM on :${live[0].port})`);
    return live[0].doc;
  }
  if (live.length > 1) {
    console.error("acm: multiple ACM editors running — pass --doc <file.md> (or set ACM_DOC):");
    for (const e of live) console.error(`  :${e.port} → ${e.doc}`);
    process.exit(1);
  }
  console.error("acm: no document — pass --doc <file.md>, set ACM_DOC, or open the doc in ACM first");
  process.exit(1);
}

/** The live ACM server serving `docPath`, if one is open (pid-alive + answers its
 *  port). When present, agent writes go THROUGH it so they merge with the human's
 *  in-editor edits instead of racing the file (issue #38). An owner whose probe
 *  timed out (rather than refused) still counts: the editor may be alive but slow
 *  (loaded machine), so the write must still route through it (or fail), never
 *  fall back to a direct write that could clobber unsaved human edits. */
async function liveServerFor(docPath: string): Promise<{ port: number } | null> {
  const owners = (await liveInstances()).filter((e) => e.doc === docPath);
  let unreachable: number | null = null;
  for (const e of owners) {
    const state = await probeInstanceState(e);
    if (state === "live") return { port: e.port };
    if (state === "unreachable" && unreachable === null) unreachable = e.port;
  }
  return unreachable === null ? null : { port: unreachable };
}

export async function runAgentVerb(cmd: string, argv: string[]): Promise<void> {
  const f = parseFlags(argv);
  const author = f.author ?? process.env.ACM_AUTHOR ?? "claude";

  // ── Import: docx → CriticMarkup .md — the ONE verb that needs no ACM_DOC ────
  if (cmd === "import") {
    await runImport(f);
    return;
  }

  // ── Spell: list / add / replace — its own sub-dispatch (add needs no doc) ────
  if (cmd === "spell") {
    await runSpell(f);
    return;
  }

  const docPath = await docPathFrom(f);

  // ── History: the git shadow record (server records; these read/restore) ──────
  if (cmd === "history") {
    const n = f.positional[0] ? Number(f.positional[0]) : 20;
    const entries = await listHistory(docPath, Number.isFinite(n) && n > 0 ? n : 20);
    if (entries.length === 0) {
      console.log("acm history: no history yet — it builds while an ACM server is editing this doc");
      return;
    }
    for (const e of entries) console.log(e);
    console.log(`\nrestore with: acm restore <sha>  (snapshots the current doc first)`);
    return;
  }
  if (cmd === "restore") {
    const ref = f.positional[0];
    if (!ref) {
      console.error("usage: acm restore <ref>   (refs from `acm history`)");
      process.exit(1);
    }
    const content = await showVersion(docPath, ref);
    if (content === null) {
      console.error(`acm restore: ${ref} not found in the history (see \`acm history\`)`);
      process.exit(1);
    }
    const snap = await snapshot(docPath, "restore"); // keep the pre-restore state
    await recordHistory(docPath, "pre-restore"); // and record it in the history, so restore is reversible
    await Bun.write(docPath, content);
    console.log(`acm restore: doc restored to ${ref}`);
    if (snap) console.log(`  pre-restore backup → ${snap}`);
    return;
  }

  // ── Read-only verb ──────────────────────────────────────────────────────────
  if (cmd === "threads") {
    const content = await Bun.file(docPath).text();
    // The human's persisted seen-set: the same ~/.config/acm/settings.json the GUI
    // hydrates from (GET /api/settings is a plain read of this file), so agents see
    // what the human has already read — no live server needed. Read-only here; only
    // the GUI marks seen.
    const cfg = await readConfig<{ seen?: unknown }>("settings.json", {});
    const seenKeys = new Set(
      Array.isArray(cfg.seen) ? cfg.seen.filter((k): k is string => typeof k === "string") : [],
    );
    const summary = threadsSummary(content, seenKeys);
    if (f.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    for (const t of summary) {
      const anchor = t.anchor ? `⟦${t.anchor.slice(0, 40)}⟧ ` : "";
      // seen: true → [seen]; null (suggestion-attached, no seen state) → [suggestion],
      // so an unmarked line always means genuinely unseen and matches the count below.
      const marks = `${t.applicable ? " [SUGGEST]" : ""}${t.seen === true ? " [seen]" : t.seen === null ? " [suggestion]" : ""}`;
      console.log(`#${t.id} (${t.count}) @${t.authors.join(" @")}${marks}  ${anchor}${t.preview}`);
    }
    // seen === null (suggestion-attached, no GUI seen state) stays out of the count,
    // matching the GUI's inbox counter.
    const unseen = summary.filter((t) => t.seen === false).length;
    console.log(`\n${summary.length} threads, ${unseen} unseen`);
    return;
  }

  // ── Mutating verbs: snapshot → transform → write → verify ─────────────────────
  const before = await Bun.file(docPath).text();
  let after: string;
  let note: string;
  // Bare `reply` (no --batch) is a single-thread reply — the same operation as
  // `comment`; dispatch both spellings to one implementation (`cmd` keeps the
  // invoked name for messages).
  const op = cmd === "reply" && !f.batch ? "comment" : cmd;
  try {
    switch (op) {
      case "apply": // deprecated spelling of `reply --batch` — "apply" is the GUI's SUGGEST-card action (CONTEXT.md)
      case "reply": {
        if (cmd === "apply") console.error("acm apply is deprecated — use `acm reply --batch <edits.json>`");
        const editsPath = f.batch ?? f.positional[0];
        if (!editsPath) throw new Error("usage: acm reply --batch <edits.json> [--doc <file>]");
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
        if (!phrase || !text) throw new Error(`usage: acm ${cmd} "<phrase>" "<text>" [--doc] [--author]`);
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
        const remaining = validateMarkup(after).length;
        note = `healed ${beforeCount - remaining} of ${beforeCount} markup issues (${remaining} remain)`;
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

  await commitWrite(docPath, before, after, cmd, note);
}

/** Snapshot → write (through a live editor's 3-way merge if one's open, else direct)
 *  → re-parse + report. The single write authority for every mutating verb (#38), so
 *  the generic verbs and `spell replace` share one battle-tested path. No-op (with a
 *  note) when `after === before`. Exits the process on a real conflict / stale editor. */
async function commitWrite(
  docPath: string,
  before: string,
  after: string,
  cmd: string,
  note: string,
): Promise<void> {
  if (after === before) {
    console.log(`acm ${cmd}: no change. ${note}`);
    return;
  }
  const snap = await snapshot(docPath, cmd); // back up the PRE-edit doc

  // If the doc is open in a live editor, route the write THROUGH the server so this
  // edit and the human's concurrent typing 3-way merge instead of clobbering (#38).
  // No live editor → write the file directly (single writer, no race).
  const live = await liveServerFor(docPath);
  let final = after;
  let viaEditorPort: number | null = null;
  if (live) {
    let res: Response | null = null;
    let refused = false;
    let failure: unknown;
    try {
      res = await fetch(`http://127.0.0.1:${live.port}/api/agent-write`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ base: before, content: after }),
        // Env override exists for the test suite (a black-holed-port test shouldn't
        // cost 10 real seconds); users never set it.
        signal: AbortSignal.timeout(Number(process.env.ACM_AGENT_WRITE_TIMEOUT_MS) || 10_000),
      });
    } catch (err) {
      refused = isConnectionRefused(err);
      failure = err;
    }

    if (!res && refused) {
      // Connection REFUSED: the editor died between the liveness probe and this POST.
      // With no live server there's no second writer to race, so a direct write is
      // safe (the pre-edit snapshot above is the recovery net).
      await Bun.write(docPath, after);
    } else if (!res) {
      // Timed out / indeterminate — the editor may be ALIVE but slow or blocked, and
      // may hold unsaved human edits. Never direct-write over a possibly-live editor:
      // fail loudly instead (the same never-fake-success stance as the skew case below).
      console.error(
        `acm ${cmd}: the ACM editor on :${live.port} did not respond to the write ` +
          `(${(failure as Error)?.message ?? "no response"}) — NOT falling back to a direct ` +
          `write, which could clobber unsaved edits in it. Nothing written. Retry in a moment; ` +
          `if that editor is actually gone, remove its :${live.port} entry from ` +
          `~/.config/acm/instances.json.`,
      );
      if (snap) console.error(`  (pre-edit backup → ${snap})`);
      process.exit(1);
    } else {
      const body = (await res.json().catch(() => null)) as
        | { version?: number; content?: string; conflict?: string }
        | null;
      if (res.status === 409 && body) {
        // A real conflict from THIS ACM (cursor guard or same-span overlap): not applied.
        const why =
          body.conflict === "cursor"
            ? "the human's cursor is in that span in the open editor"
            : "the document changed under this edit in the open editor";
        console.error(`acm ${cmd}: NOT applied — ${why}. Retry in a moment.`);
        if (snap) console.error(`  (nothing written; pre-edit backup → ${snap})`);
        process.exit(1);
      }
      if (!res.ok || !body || typeof body.version !== "number") {
        // The server answered, but NOT with the agent-write protocol — almost certainly
        // an OLDER ACM on this port whose SPA fallback served HTML (or a 5xx). Do NOT
        // fall back to a direct write: that editor is ALIVE and may hold unsaved human
        // edits a blind write would clobber. Fail loudly so it gets rebuilt + retried.
        console.error(
          `acm ${cmd}: the ACM editor on :${live.port} did not accept the write ` +
            `(HTTP ${res.status}; not an agent-write response) — it's likely running an ` +
            `older build. Rebuild/restart it (\`just install\`) and retry. Nothing written.`,
        );
        if (snap) console.error(`  (pre-edit backup → ${snap})`);
        process.exit(1);
      }
      if (body.content !== undefined) final = body.content; // the merged bytes now on disk
      viaEditorPort = live.port;
    }
  } else {
    await Bun.write(docPath, after);
  }

  const toks = scanTokens(final);
  const comments = toks.filter((t) => t.type === "comment").length;
  console.log(`acm ${cmd}: ${note}`);
  if (snap) console.log(`  backup → ${snap}`);
  if (viaEditorPort !== null)
    console.log(`  written via the live editor on :${viaEditorPort} (merged with any concurrent human edits)`);
  console.log(`  comments: ${comments} | applicable SUGGEST cards: ${applicableSuggestionIds(final, toks).size}`);
}

// ── acm spell [list|add|ignore|replace] — review & fix spelling from the shell ─
// The browser checker (editor/spellcheck.ts) only runs inside the editor; this is
// the same engine over a raw .md (cli/spellEngine.ts), reading the SAME persisted
// variant (UK/US) and personal dictionary the GUI uses. Four sub-verbs:
//   list (default) — every flagged word, counts, suggestions (--json for agents)
//   add <word…>    — keep words: append to the personal dictionary (shared with GUI)
//   ignore <word…> — stop flagging words in THIS doc only (settings.json spellIgnore
//                    keyed by absolute doc path; the GUI seeds its session ignore set
//                    from it, so squiggles agree). For foreign words/names that are
//                    valid here but don't belong in the global dictionary.
//   replace <w> <r>— fix every flagged occurrence of <w> in the doc, case-preserving

/** The persisted spelling variant + personal dictionary + per-doc ignore lists
 *  (~/.config/acm/settings.json), with fresh-install defaults (British, empty). */
async function spellConfig(): Promise<{
  variant: SpellVariant;
  dictionary: string[];
  spellIgnore: Record<string, string[]>;
}> {
  const cfg = await readConfig<{
    settings?: { spellVariant?: SpellVariant };
    dictionary?: unknown;
    spellIgnore?: unknown;
  }>("settings.json", {});
  const ig = cfg.spellIgnore;
  return {
    variant: cfg.settings?.spellVariant === "us" ? "us" : "uk",
    dictionary: Array.isArray(cfg.dictionary) ? (cfg.dictionary as string[]) : [],
    spellIgnore:
      ig && typeof ig === "object" && !Array.isArray(ig) ? (ig as Record<string, string[]>) : {},
  };
}

/** Any live ACM server (settings are global, not per-doc, so any owner will do).
 *  Callers writing settings fall back to a direct writeConfig when this is null,
 *  so an UNREACHABLE editor (probe timed out — possibly alive but slow) must not
 *  collapse to "none": that direct write would race the running server's own
 *  settings writes. Fail loudly instead, same stance as commitWrite. */
async function anyLiveServer(): Promise<{ port: number } | null> {
  // Scan ALL instances before deciding: settings are global, so ANY unreachable
  // editor makes the write unsafe — routing through a different live one doesn't
  // help, and the answer must not depend on registry (port) order.
  const registered = await liveInstances();
  const states = await Promise.all(registered.map(probeInstanceState));
  const wedged = registered.find((_, i) => states[i] === "unreachable");
  if (wedged) {
    console.error(
      `acm: the ACM editor on :${wedged.port} did not answer its port (busy machine?) — ` +
        `not writing settings behind its back. Nothing written. Retry in a moment; if that ` +
        `editor is actually gone, remove its :${wedged.port} entry from ~/.config/acm/instances.json.`,
    );
    process.exit(1);
  }
  const live = registered.find((_, i) => states[i] === "live");
  return live ? { port: live.port } : null;
}

/** 1-based line number of `offset` in `text` (for the list view). */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

async function runSpell(f: Flags): Promise<void> {
  const sub = f.positional[0] ?? "list";
  if (sub === "add") return runSpellAdd(f);
  if (sub !== "list" && sub !== "ignore" && sub !== "replace") {
    console.error(`acm spell: unknown subcommand "${sub}" — use: list | add | ignore | replace`);
    process.exit(1);
  }

  const docPath = await docPathFrom(f);
  if (sub === "ignore") return runSpellIgnore(f, docPath);
  const { variant, dictionary, spellIgnore } = await spellConfig();
  const ignored = spellIgnore[docPath] ?? [];
  const engine = loadSpellEngine(variant, dictionary, ignored);
  const before = await Bun.file(docPath).text();

  if (sub === "list") {
    printFlagged(engine, before, f.json);
    if (!f.json && ignored.length)
      console.log(`  (${ignored.length} word${ignored.length === 1 ? "" : "s"} ignored for this doc — acm spell ignore)`);
    return;
  }

  // replace <word> <replacement>
  const word = f.positional[1];
  const replacement = f.positional[2];
  if (!word || replacement === undefined) {
    console.error('usage: acm spell replace "<word>" "<replacement>" [--doc <file>]');
    process.exit(1);
  }
  const after = engine.applyReplaceAll(before, word.toLowerCase(), replacement);
  if (after === before) {
    console.log(`acm spell replace: no flagged "${word}" in the document — nothing to replace`);
    return;
  }
  await commitWrite(docPath, before, after, "spell replace", `replaced every flagged "${word}" → "${replacement}"`);
}

/** `acm spell add <word…>` — append to the personal dictionary. Routed through a live
 *  editor's /api/settings (server merges under withLock) when one's open, else written
 *  to the config file directly. Shared with the GUI's "Add to dictionary". */
async function runSpellAdd(f: Flags): Promise<void> {
  const words = f.positional.slice(1).map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (words.length === 0) {
    console.error("usage: acm spell add <word> [word…]   (keeps words in your personal dictionary)");
    process.exit(1);
  }
  const cfg = await readConfig<Record<string, unknown>>("settings.json", {});
  const current = Array.isArray(cfg.dictionary) ? (cfg.dictionary as string[]) : [];
  const merged = [...new Set([...current, ...words])].sort();
  const added = merged.filter((w) => !current.includes(w));

  const live = await anyLiveServer();
  if (live) {
    const res = await fetch(`http://127.0.0.1:${live.port}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dictionary: merged }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res || !res.ok) {
      console.error(`acm spell add: the ACM editor on :${live.port} did not accept the update — nothing written.`);
      process.exit(1);
    }
  } else {
    await writeConfig("settings.json", { ...cfg, dictionary: merged });
  }

  if (added.length === 0) {
    console.log(`acm spell add: nothing new — already in your dictionary (${merged.length} words)`);
    return;
  }
  console.log(`acm spell add: +${added.length} → ${added.join(", ")}`);
  console.log(`  personal dictionary now ${merged.length} words (~/.config/acm/settings.json)`);
  if (live) console.log(`  click back into the open editor to clear their squiggles (it re-reads on focus)`);
}

/** `acm spell ignore <word…>` — stop flagging words in THIS doc only. Stored in
 *  settings.json under spellIgnore[<abs doc path>]; the GUI seeds its session ignore
 *  set from the same list, so the CLI and the squiggles agree. Unlike `add`, the
 *  words are never taught to the speller and never leave this document. */
async function runSpellIgnore(f: Flags, docPath: string): Promise<void> {
  const words = f.positional.slice(1).map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (words.length === 0) {
    console.error("usage: acm spell ignore <word> [word…]   (stops flagging them in THIS doc only)");
    process.exit(1);
  }
  const cfg = await readConfig<Record<string, unknown>>("settings.json", {});
  const rawMap = cfg.spellIgnore;
  const map: Record<string, string[]> =
    rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)
      ? { ...(rawMap as Record<string, string[]>) }
      : {};
  const current = Array.isArray(map[docPath]) ? map[docPath] : [];
  const merged = [...new Set([...current, ...words])].sort();
  const added = merged.filter((w) => !current.includes(w));
  map[docPath] = merged;

  const live = await anyLiveServer();
  if (live) {
    const res = await fetch(`http://127.0.0.1:${live.port}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spellIgnore: map }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res || !res.ok) {
      console.error(`acm spell ignore: the ACM editor on :${live.port} did not accept the update — nothing written.`);
      process.exit(1);
    }
  } else {
    await writeConfig("settings.json", { ...cfg, spellIgnore: map });
  }

  if (added.length === 0) {
    console.log(`acm spell ignore: nothing new — already ignored for this doc (${merged.length} words)`);
    return;
  }
  console.log(`acm spell ignore: +${added.length} → ${added.join(", ")}`);
  console.log(`  ${merged.length} word${merged.length === 1 ? "" : "s"} ignored for ${docPath}`);
  if (live) console.log(`  click back into the open editor to clear their squiggles (it re-reads on focus)`);
}

/** Print the flagged words (one row each) or a JSON array for agent consumption. */
function printFlagged(engine: SpellEngine, text: string, json: boolean): void {
  const rows = engine.flagged(text).map((w) => ({
    word: w.word,
    lower: w.lower,
    count: w.count,
    line: lineOf(text, w.from),
    suggestions: engine.suggest(w.word),
  }));
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("acm spell: no misspellings — all clear ✓");
    return;
  }
  for (const r of rows) {
    const count = r.count > 1 ? ` ×${r.count}` : "";
    const sugg = r.suggestions.length ? `  →  ${r.suggestions.join(", ")}` : "  (no suggestions)";
    console.log(`  ${r.word}${count}${sugg}   ·  L${r.line}`);
  }
  console.log(
    `\n${rows.length} word${rows.length === 1 ? "" : "s"} flagged` +
      `\n  fix:  acm spell replace "<word>" "<correction>"` +
      `\n  keep: acm spell add "<word>" [word…]`,
  );
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
  const srcPath = resolve(src);
  if (!(await Bun.file(srcPath).exists())) {
    console.error(`acm import: file not found: ${src}`);
    process.exit(1);
  }
  const out = resolve(outArg ?? src.replace(/\.docx$/i, ".md"));
  const converter =
    process.env.ACM_CONVERTER ?? `${process.env.HOME}/Projects/acm-seed/convert.py`;
  if (!(await Bun.file(converter).exists())) {
    console.error(`acm import: converter not found at ${converter} — set ACM_CONVERTER`);
    process.exit(1);
  }
  const proc = Bun.spawn(["uv", "run", converter, srcPath, out], {
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
