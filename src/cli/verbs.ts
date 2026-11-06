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
import { readConfig, updateConfig } from "../server/config";
import {
  AmbiguityError,
  appendToThread,
  addComment,
  addAnchoredComment,
  addSuggestion,
  addSuggestionsAt,
  type SuggestionAt,
  resolveSuggestion,
  resolveSuggestionGroup,
  resolveThread,
  threadsSummary,
  findSuggestionComment,
  findThread,
  suggestionWhitespaceWarning,
} from "../lib/agentEdits";
import {
  applicableSuggestionIds,
  canonicalizeCommentMarker,
  hardWrap,
  healDocument,
  scanTokens,
  validateMarkup,
} from "../lib/criticmarkup";
import { loadSpellEngine } from "./spellEngine";
import type { SpellEngine } from "./spellEngine";
import { matchCase } from "../lib/spellModel";
import type { SpellVariant } from "../lib/viewSettings";
import { seenStateForDocument } from "../lib/seenState";
import { importDocument } from "./docxImport";
import {
  appendDecisionEvents,
  listDecisionEvents,
  readDecisionHistory,
} from "../server/decisions";
import { storeDecisionRecoveryEvents } from "../server/decisionRecovery";
import { documentUpdateLockPath, withFileUpdateLock } from "../server/fileLock";
import {
  decisionEventsAcknowledged,
  rebaseDecisionEventsForCommit,
  structuredSuggestionDecision,
  structuredSuggestionGroupDecisions,
  threadResolveDecision,
  type DecisionEvent,
} from "../lib/decision";
import { merge3 } from "../lib/merge";
import { recordProvenanceWrite } from "../server/provenance";

const VERBS = new Set(["reply", "apply", "comment", "suggest", "accept", "reject", "resolve", "threads", "wrap", "import", "heal", "history", "decisions", "restore", "spell"]);
export function isAgentVerb(cmd?: string): boolean {
  return !!cmd && VERBS.has(cmd);
}

interface Flags {
  doc?: string;
  author?: string;
  group?: string;
  batch?: string;
  json: boolean;
  reply: boolean;
  positional: string[];
}
function parseFlags(argv: string[]): Flags {
  const f: Flags = { json: false, reply: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--doc") f.doc = argv[++i];
    else if (a === "--author") f.author = argv[++i];
    else if (a === "--group") f.group = argv[++i];
    else if (a === "--batch") f.batch = argv[++i];
    else if (a === "--json") f.json = true;
    else if (a === "--reply" || a === "-r") f.reply = true;
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

async function persistDecisionEventsViaServer(
  port: number,
  documentPath: string,
  events: readonly DecisionEvent[],
): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentPath, decisionEvents: events }),
      signal: AbortSignal.timeout(Number(process.env.ACM_AGENT_WRITE_TIMEOUT_MS) || 10_000),
    });
    const body = (await res.json().catch(() => null)) as
      | { audit?: { status?: unknown; decisionEventIds?: unknown } }
      | null;
    return (
      res.ok &&
      body?.audit?.status === "persisted" &&
      Array.isArray(body.audit.decisionEventIds) &&
      body.audit.decisionEventIds.length === events.length &&
      body.audit.decisionEventIds.every((id, index) => id === events[index].id)
    );
  } catch {
    return false;
  }
}

export async function rollBackUnauditedLiveWrite(
  port: number,
  documentPath: string,
  before: string,
  proposed: string,
  committed: string,
): Promise<boolean> {
  const inverse = merge3(before, proposed, committed);
  if (!inverse.clean) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base: committed,
        content: inverse.result,
        documentPath,
        author: "acm-cli",
        operation: "audit rollback",
        decisionEvents: [],
      }),
      signal: AbortSignal.timeout(Number(process.env.ACM_AGENT_WRITE_TIMEOUT_MS) || 10_000),
    });
    const body = (await res.json().catch(() => null)) as
      | { version?: number; content?: string }
      | null;
    return res.ok && typeof body?.version === "number";
  } catch {
    return false;
  }
}

export interface DirectAuditRecovery {
  status: "stored" | "failed";
  decisionEventIds: string[];
  message?: string;
}

export interface DirectAuditFailure {
  status: "audit-failed";
  restored: boolean;
  message: string;
  retainedForAuditConsistency?: true;
  auditRecovery?: DirectAuditRecovery;
}

export type DirectWriteResult =
  | { status: "written"; content: string }
  | { status: "conflict"; content: string }
  | DirectAuditFailure;

export interface DirectWriteIdentity {
  author: string;
  operation?: string;
}

export function directAuditFailureGuidance(result: DirectAuditFailure): string[] {
  if (result.retainedForAuditConsistency) {
    const recovery = result.auditRecovery;
    return [
      "  document was retained because its decision-history state could not be safely reversed",
      recovery?.status === "stored"
        ? "  missing decision evidence was queued for retry by the next ACM editor; do not restore the backup"
        : `  missing decision evidence could not be queued: ${recovery?.message ?? "unknown recovery failure"}; do not restore the backup`,
    ];
  }
  return [
    result.restored
      ? "  document was restored; no review decision was applied"
      : "  CRITICAL: document rollback also failed; restore the pre-edit backup before continuing",
  ];
}

export async function writeDirectWithAudit(
  documentPath: string,
  before: string,
  proposed: string,
  decisionEvents: readonly DecisionEvent[],
  persistDecisionEvents: (
    docPath: string,
    events: readonly DecisionEvent[],
  ) => Promise<{ appended: number }> = appendDecisionEvents,
  identity: DirectWriteIdentity = { author: "Agent", operation: "agent edit" },
): Promise<DirectWriteResult> {
  return withFileUpdateLock(
    documentUpdateLockPath(documentPath),
    `document ${documentPath}`,
    async () => {
      const current = await Bun.file(documentPath).text();
      const merged = merge3(proposed, before, current);
      if (!merged.clean) return { status: "conflict", content: current };
      const committedDecisionEvents = rebaseDecisionEventsForCommit(
        decisionEvents,
        { base: before, mine: proposed, theirs: current, committed: merged.result },
      );
      await Bun.write(documentPath, merged.result);
      const recordCommittedProvenance = async () => {
        try {
          await recordProvenanceWrite(documentPath, current, merged.result, {
            author: identity.author.trim() || "Agent",
            source: "agent",
            timestamp: new Date().toISOString(),
            operation: identity.operation ?? "agent edit",
          }, committedDecisionEvents);
        } catch {
          // Markdown remains authoritative; a later editor can start a fresh baseline.
        }
      };
      if (committedDecisionEvents.length === 0) {
        await recordCommittedProvenance();
        return { status: "written", content: merged.result };
      }

      try {
        await persistDecisionEvents(documentPath, committedDecisionEvents);
        await recordCommittedProvenance();
        return { status: "written", content: merged.result };
      } catch (initialError) {
        const readPersistedIds = async (): Promise<Set<string> | null> => {
          try {
            return new Set(
              (await listDecisionEvents(documentPath)).map((event) => event.id),
            );
          } catch {
            return null;
          }
        };
        const allPersisted = (ids: Set<string> | null): boolean =>
          ids !== null && committedDecisionEvents.every((event) => ids.has(event.id));
        const anyPersisted = (ids: Set<string> | null): boolean =>
          ids === null || committedDecisionEvents.some((event) => ids.has(event.id));

        let persistedIds = await readPersistedIds();
        if (allPersisted(persistedIds)) {
          await recordCommittedProvenance();
          return { status: "written", content: merged.result };
        }

        const initialPersistedIds = persistedIds;
        const missingEvents = initialPersistedIds === null
          ? committedDecisionEvents
          : committedDecisionEvents.filter((event) => !initialPersistedIds.has(event.id));
        let auditError: unknown = initialError;
        let retrySucceeded = false;
        try {
          await persistDecisionEvents(documentPath, missingEvents);
          retrySucceeded = true;
        } catch (retryError) {
          auditError = retryError;
        }

        persistedIds = await readPersistedIds();
        if (allPersisted(persistedIds) || (retrySucceeded && persistedIds === null)) {
          await recordCommittedProvenance();
          return { status: "written", content: merged.result };
        }
        if (retrySucceeded) {
          auditError = new Error("Decision history retry did not persist every decision event.");
        }
        if (anyPersisted(persistedIds)) {
          const missingRecoveryEvents = persistedIds === null
            ? committedDecisionEvents
            : committedDecisionEvents.filter((event) => !persistedIds.has(event.id));
          let auditRecovery: DirectAuditRecovery;
          try {
            await storeDecisionRecoveryEvents(documentPath, missingRecoveryEvents);
            auditRecovery = {
              status: "stored",
              decisionEventIds: missingRecoveryEvents.map((event) => event.id),
            };
          } catch (recoveryError) {
            auditRecovery = {
              status: "failed",
              decisionEventIds: missingRecoveryEvents.map((event) => event.id),
              message: (recoveryError as Error).message,
            };
          }
          await recordCommittedProvenance();
          return {
            status: "audit-failed",
            restored: false,
            message: (auditError as Error).message,
            retainedForAuditConsistency: true,
            auditRecovery,
          };
        }

        let restored = false;
        try {
          const committed = await Bun.file(documentPath).text();
          const inverse = merge3(current, merged.result, committed);
          if (inverse.clean) {
            await Bun.write(documentPath, inverse.result);
            restored = true;
          }
        } catch {
          // The pre-edit snapshot remains the last recovery route.
        }
        return {
          status: "audit-failed",
          restored,
          message: (auditError as Error).message,
        };
      }
    },
  );
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
    await runSpell(f, author);
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
  if (cmd === "decisions") {
    const n = f.positional[0] ? Number(f.positional[0]) : 20;
    const limit = Number.isFinite(n) && n > 0 ? n : 20;
    const history = await readDecisionHistory(docPath);
    const events = history.decisionEvents.slice(-limit).reverse();
    if (f.json) {
      console.log(
        JSON.stringify(
          {
            decisionEvents: events,
            ...(history.issues.length > 0 ? { decisionHistoryIssues: history.issues } : {}),
          },
          null,
          2,
        ),
      );
      return;
    }
    for (const issue of history.issues) {
      console.error(`acm decisions: warning: ${issue.message}`);
    }
    if (events.length === 0) {
      console.log("acm decisions: no review decisions recorded for this document");
      return;
    }
    for (const event of events) {
      const target = `${event.target.kind}:${event.target.id}`;
      const anchor = event.anchor ? ` — ${event.anchor.slice(0, 60)}` : "";
      console.log(`${event.timestamp}  ${event.actor}  ${event.action}  ${target}${anchor}`);
    }
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
    const beforeRestore = await Bun.file(docPath).text();
    const snap = await snapshot(docPath, "restore"); // keep the pre-restore state
    await recordHistory(docPath, "pre-restore"); // and record it in the history, so restore is reversible
    await Bun.write(docPath, content);
    try {
      await recordProvenanceWrite(docPath, beforeRestore, content, {
        author: author.trim() || "Agent",
        source: "restore",
        timestamp: new Date().toISOString(),
        operation: `restore ${ref}`,
      });
    } catch {
      // The restored Markdown remains authoritative if auxiliary provenance fails.
    }
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
    const cfg = await readConfig<Record<string, unknown>>("settings.json", {});
    const seenKeys = new Set(seenStateForDocument(cfg, docPath).keys);
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
  let decisionEvents: DecisionEvent[] = [];
  // Bare `reply` (no --batch) is a single-thread reply — the same operation as
  // `comment --reply`; dispatch both spellings to one implementation (`cmd` keeps
  // the invoked name for messages).
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
            const marker = canonicalizeCommentMarker(e.insert);
            const r = appendToThread(content, e.match, marker); // re-scans each time → offsets fresh
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
        if (cmd === "reply" || f.reply) {
          // Reply: thread onto the one existing comment whose body matches <phrase>.
          const [phrase, text] = f.positional;
          const usage = cmd === "reply" ? "acm reply" : "acm comment --reply";
          if (!phrase || !text) throw new Error(`usage: ${usage} "<phrase>" "<text>" [--doc] [--author]`);
          if (f.group) throw new Error(`--group tags a new comment; a reply joins its thread (drop --group)`);
          after = addComment(before, phrase, author, text);
          note = `replied to "${phrase.slice(0, 40)}" as @${author}`;
          break;
        }
        // New comment: anchor on the unique prose <span> (#42).
        const [span, text] = f.positional;
        if (!span || !text)
          throw new Error('usage: acm comment "<span>" "<text>" [--group <id>] [--doc] [--author]  (reply: --reply/-r)');
        after = addAnchoredComment(before, span, author, text, f.group);
        note = `comment${f.group ? ` [g:${f.group}]` : ""} anchored on "${span.slice(0, 40)}" as @${author}`;
        break;
      }
      case "suggest": {
        const [span, replacement] = f.positional;
        if (!span || replacement === undefined)
          throw new Error('usage: acm suggest "<span>" "<new wording>" [--group <id>] [--doc] [--author]');
        after = addSuggestion(before, span, author, replacement, f.group);
        note = `SUGGEST${f.group ? `[g:${f.group}]` : ""} anchored on "${span.slice(0, 40)}" as @${author}`;
        const whitespace = suggestionWhitespaceWarning(span, replacement);
        if (whitespace) note += `\n  ⚠ ${whitespace}`;
        break;
      }
      case "accept":
      case "reject": {
        if (f.group) {
          // Whole-group resolution (#21): every member edit lands in ONE write.
          const r = resolveSuggestionGroup(before, f.group, op);
          after = r.content;
          decisionEvents = structuredSuggestionGroupDecisions(
            before,
            f.group,
            op,
            op,
            author,
            "cli",
          );
          if (decisionEvents.length !== r.applied) {
            throw new Error(`could not build audit events for every applied member of group "${f.group}"`);
          }
          note = `${cmd}ed suggestion group "${f.group}" — ${r.applied} edits${r.skipped ? `, ${r.skipped} skipped` : ""}`;
          break;
        }
        const [phrase] = f.positional;
        if (!phrase) throw new Error(`usage: acm ${cmd} "<phrase>" | acm ${cmd} --group <id>  [--doc]`);
        const comment = findSuggestionComment(before, phrase);
        after = resolveSuggestion(before, phrase, op);
        const event = structuredSuggestionDecision(before, comment, op, op, author, "cli");
        if (!event) throw new Error(`"${phrase.slice(0, 48)}" is not an anchored suggestion`);
        decisionEvents = [event];
        note = `${cmd}ed the suggestion matching "${phrase.slice(0, 40)}"`;
        break;
      }
      case "resolve": {
        const [phrase] = f.positional;
        if (!phrase) throw new Error('usage: acm resolve "<phrase>" [--doc]');
        const thread = findThread(before, phrase);
        after = resolveThread(before, phrase);
        decisionEvents = [threadResolveDecision(before, thread, author, "cli")];
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

  await commitWrite(docPath, before, after, cmd, note, decisionEvents, author);
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
  decisionEvents: DecisionEvent[] = [],
  author = "Agent",
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
  const commitDirect = async () => {
    const result = await writeDirectWithAudit(
      docPath,
      before,
      after,
      decisionEvents,
      undefined,
      { author, operation: cmd },
    );
    if (result.status === "written") {
      final = result.content;
      return;
    }
    if (result.status === "conflict") {
      console.error(
        `acm ${cmd}: NOT applied — the document changed under this direct edit. Retry in a moment.`,
      );
      if (snap) console.error(`  (nothing written; pre-edit backup → ${snap})`);
      process.exit(1);
    }
    console.error(
      `acm ${cmd}: the document changed, but its decision history could not be persisted: ` +
        result.message,
    );
    for (const line of directAuditFailureGuidance(result)) console.error(line);
    if (snap) console.error(`  pre-edit backup → ${snap}`);
    process.exit(1);
  };
  if (live) {
    if (
      decisionEvents.length > 0 &&
      !(await persistDecisionEventsViaServer(live.port, docPath, []))
    ) {
      console.error(
        `acm ${cmd}: the ACM editor on :${live.port} does not support durable decision history. ` +
          `Rebuild/restart it before applying this review decision. Nothing written.`,
      );
      if (snap) console.error(`  (pre-edit backup → ${snap})`);
      process.exit(1);
    }
    let res: Response | null = null;
    let refused = false;
    let failure: unknown;
    try {
      res = await fetch(`http://127.0.0.1:${live.port}/api/agent-write`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          base: before,
          content: after,
          documentPath: docPath,
          author,
          operation: cmd,
          decisionEvents,
        }),
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
      await commitDirect();
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
        | {
            version?: number;
            content?: string;
            conflict?: string;
            audit?: {
              status?: string;
              code?: string;
              retryable?: boolean;
              decisionEvents?: DecisionEvent[];
              decisionEventIds?: string[];
            };
          }
        | null;
      let auditRecovered = false;
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
        if (
          body?.audit?.status === "failed" &&
          body.audit.code === "decision-persistence" &&
          typeof body.content === "string"
        ) {
          if (await persistDecisionEventsViaServer(live.port, docPath, decisionEvents)) {
            final = body.content;
            viaEditorPort = live.port;
            auditRecovered = true;
          } else {
            const restored = await rollBackUnauditedLiveWrite(
              live.port,
              docPath,
              before,
              after,
              body.content,
            );
            console.error(
              `acm ${cmd}: the document changed, but its decision history could not be persisted.`,
            );
            console.error(
              restored
                ? "  document was restored; no review decision was applied"
                : "  CRITICAL: document rollback also failed; restore the pre-edit backup before continuing",
            );
            if (snap) console.error(`  pre-edit backup → ${snap}`);
            process.exit(1);
          }
        } else {
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
      }
      if (
        decisionEvents.length > 0 &&
        !auditRecovered &&
        !decisionEventsAcknowledged(decisionEvents, body.audit)
      ) {
        if (!(await persistDecisionEventsViaServer(live.port, docPath, decisionEvents))) {
          const restored =
            typeof body.content === "string" &&
            (await rollBackUnauditedLiveWrite(live.port, docPath, before, after, body.content));
          console.error(
            `acm ${cmd}: the editor changed the document but did not persist decision history.`,
          );
          console.error(
            restored
              ? "  document was restored; no review decision was applied"
              : "  CRITICAL: document rollback also failed; restore the pre-edit backup before continuing",
          );
          if (snap) console.error(`  pre-edit backup → ${snap}`);
          process.exit(1);
        }
      }
      if (body.content !== undefined) final = body.content; // the merged bytes now on disk
      viaEditorPort = live.port;
    }
  } else {
    await commitDirect();
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
//   suggest [word…] — one anchored SUGGEST[g:spelling] card per flagged occurrence
//                    (top suggestion as the replacement), never auto-applied; the
//                    human Applies/Rejects each, or the whole group at once (#29)

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

async function runSpell(f: Flags, author: string): Promise<void> {
  const sub = f.positional[0] ?? "list";
  if (sub === "add") return runSpellAdd(f);
  if (sub !== "list" && sub !== "ignore" && sub !== "replace" && sub !== "suggest") {
    console.error(`acm spell: unknown subcommand "${sub}" — use: list | add | ignore | replace | suggest`);
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

  if (sub === "suggest") return runSpellSuggest(f, engine, docPath, before, author);

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
  await commitWrite(
    docPath,
    before,
    after,
    "spell replace",
    `replaced every flagged "${word}" → "${replacement}"`,
    [],
    author,
  );
}

/** `acm spell suggest [word…]` — one anchored SUGGEST card per flagged occurrence
 *  (all flagged words, or only the given ones), the top suggestion as the
 *  replacement, all in one group (`--group`, default "spelling") so the human can
 *  Apply all. Proposals only — nothing is corrected until the human applies. Words
 *  inside existing anchors/markup (including cards from an earlier run) are skipped,
 *  so a re-run adds only what's new. Writes through commitWrite like every verb. */
async function runSpellSuggest(
  f: Flags,
  engine: SpellEngine,
  docPath: string,
  before: string,
  author: string,
): Promise<void> {
  const group = f.group ?? "spelling";
  if (!/^[^\]\s]+$/.test(group)) {
    console.error(`acm spell suggest: invalid group id "${group}" (no spaces or "]")`);
    process.exit(1);
  }
  const only = new Set(f.positional.slice(1).map((w) => w.trim().toLowerCase()).filter(Boolean));
  const top = new Map<string, string | undefined>();
  const noSuggestion = new Set<string>();
  const spans: SuggestionAt[] = [];
  for (const o of engine.occurrences(before)) {
    const lower = o.word.toLowerCase();
    if (only.size > 0 && !only.has(lower)) continue;
    if (!top.has(o.word)) top.set(o.word, engine.suggest(o.word)[0]);
    const best = top.get(o.word);
    if (!best) {
      noSuggestion.add(o.word);
      continue;
    }
    spans.push({ from: o.from, to: o.to, replacement: matchCase(o.word, best) });
  }
  const { content: after, skipped } = addSuggestionsAt(before, spans, author, group);
  const added = spans.length - skipped.length;
  let note = `${added} SUGGEST[g:${group}] card${added === 1 ? "" : "s"} for flagged words as @${author}` +
    ` — review them in the editor (Apply all applies the group)`;
  if (skipped.length)
    note += `\n  skipped ${skipped.length} inside existing markup: ` +
      [...new Set(skipped.map((s) => before.slice(s.from, s.to)))].join(", ");
  if (noSuggestion.size) note += `\n  no suggestion for: ${[...noSuggestion].join(", ")}`;
  if (only.size > 0 && spans.length === 0 && noSuggestion.size === 0)
    note += `\n  none of ${[...only].join(", ")} is flagged in the document`;
  await commitWrite(docPath, before, after, "spell suggest", note, [], author);
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
  const live = await anyLiveServer();
  let merged: string[] = [];
  let added: string[] = [];
  if (live) {
    const cfg = await readConfig<Record<string, unknown>>("settings.json", {});
    const current = Array.isArray(cfg.dictionary) ? (cfg.dictionary as string[]) : [];
    merged = [...new Set([...current, ...words])].sort();
    added = merged.filter((word) => !current.includes(word));
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
    await updateConfig<Record<string, unknown>>("settings.json", {}, (cfg) => {
      const current = Array.isArray(cfg.dictionary) ? (cfg.dictionary as string[]) : [];
      merged = [...new Set([...current, ...words])].sort();
      added = merged.filter((word) => !current.includes(word));
      return { ...cfg, dictionary: merged };
    });
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
  const live = await anyLiveServer();
  let merged: string[] = [];
  let added: string[] = [];
  if (live) {
    const cfg = await readConfig<Record<string, unknown>>("settings.json", {});
    const rawMap = cfg.spellIgnore;
    const map: Record<string, string[]> =
      rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)
        ? { ...(rawMap as Record<string, string[]>) }
        : {};
    const current = Array.isArray(map[docPath]) ? map[docPath] : [];
    merged = [...new Set([...current, ...words])].sort();
    added = merged.filter((word) => !current.includes(word));
    map[docPath] = merged;
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
    await updateConfig<Record<string, unknown>>("settings.json", {}, (cfg) => {
      const rawMap = cfg.spellIgnore;
      const map: Record<string, string[]> =
        rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)
          ? { ...(rawMap as Record<string, string[]>) }
          : {};
      const current = Array.isArray(map[docPath]) ? map[docPath] : [];
      merged = [...new Set([...current, ...words])].sort();
      added = merged.filter((word) => !current.includes(word));
      map[docPath] = merged;
      return { ...cfg, spellIgnore: map };
    });
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
      `\n  propose fixes as SUGGEST cards: acm spell suggest [word…]` +
      `\n  fix:  acm spell replace "<word>" "<correction>"` +
      `\n  keep: acm spell add "<word>" [word…]`,
  );
}

// ── acm import <Google Docs URL|file.docx> [out.md] → CriticMarkup ────────────
async function runImport(f: Flags): Promise<void> {
  const [src, outArg] = f.positional;
  if (!src) {
    console.error("usage: acm import <Google Docs URL|file.docx> [out.md]");
    process.exit(1);
  }
  let imported: Awaited<ReturnType<typeof importDocument>>;
  try {
    imported = await importDocument(src, outArg);
  } catch (error) {
    console.error(`acm import: ${(error as Error).message}`);
    process.exit(1);
  }
  const diags = validateMarkup(imported.markdown);
  console.log(`acm import: ${imported.outputPath}`);
  console.log(
    `  comments: ${imported.comments} (${imported.highlights} anchored, ${imported.comments - imported.highlights} point)`,
  );
  console.log(
    `  markup diagnostics: ${diags.length === 0 ? "0 (clean)" : `${diags.length} — open in ACM and click Review`}`,
  );
}
