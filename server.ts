// ── ACM live file-sync server (Bun native) ────────────────────────────────────
// The .md file on disk is the source of truth. This module exposes startServer()
// so both the dev entry (env-driven, below) and the `acm` CLI (cli.ts) can boot it
// against an explicit doc path — no hidden ACM_DOC indirection that can silently
// point at the wrong copy.
//
// Each server instance:
//   • serves the doc (GET /api/doc) + accepts version-checked human writes (PUT)
//   • lets agents drop comments (POST /api/comment) via the shared grammar
//   • broadcasts EXTERNAL file changes to browsers over a WebSocket (~1s)
//   • serves the built SPA from ./dist in production
//
// Loop-prevention is a SINGLE content-hash gate: `lastKnownHash` is updated on
// every write WE make (PUT / POST / broadcast), and the directory watcher drops
// any event whose freshly-read content hashes to that same value (our own echo).

import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import type { ServerMessage } from "./src/lib/types";
import { insertComment } from "./src/lib/criticmarkup";
import { addAnchoredComment } from "./src/lib/agentEdits";
import { KEEP_VERSIONS, merge3, mergeKeepingBoth, changedSpan, changedFragments } from "./src/lib/merge";
import { readConfig, SETTINGS_FILE, updateConfig } from "./src/server/config";
import { registerInstance } from "./src/server/instances";
import { recordHistory } from "./src/server/history";
import { readDocText, startsWithBomChar, writeDocText } from "./src/server/docText";
import { saveAsset, assetRootFor, resolveAsset } from "./src/server/asset";
import { IMAGE_EXTS_LABEL } from "./src/lib/imageTypes";
import {
  isDecisionEvent,
  rebaseDecisionEventsForCommit,
  type DecisionEvent,
} from "./src/lib/decision";
import {
  appendDecisionEvent as appendDecisionEventToStore,
  appendDecisionEvents as appendDecisionEventsToStore,
  readDecisionHistory,
} from "./src/server/decisions";
import { isLoopbackHost, refuseOutsideBoundary, resolveAllowedHosts, serveAppAsset } from "./src/server/http";
import { createUserReviewSkill, findUserReviewSkill, NO_REVIEW_PREFERENCES } from "./src/server/reviewSkill";
import { tailscaleDnsName } from "./src/server/tailscale";
import { mergeConfigPatch } from "./src/lib/seenState";
import { documentUpdateLockPath, withFileUpdateLock } from "./src/server/fileLock";
import {
  readDocumentProvenanceRange,
  recordProvenanceWrite,
} from "./src/server/provenance";
import type { ProvenanceAttribution, ProvenanceSource } from "./src/lib/provenance";
import {
  clearDecisionRecoveryEvents as clearDecisionRecoveryEventsInStore,
  readDecisionRecoveryEvents as readDecisionRecoveryEventsFromStore,
  storeDecisionRecoveryEvents as storeDecisionRecoveryEventsInStore,
} from "./src/server/decisionRecovery";

const DOC_TOPIC = "doc";

export interface StartServerOptions {
  /** Absolute or relative path to the CriticMarkup .md doc (the source of truth). */
  docPath: string;
  /** Port to listen on. */
  port: number;
  /** Directory holding the built SPA to serve in production (default ./dist). */
  staticDir?: string;
  /** Embedded SPA assets (url-path → bun file path) — used by the compiled binary.
   *  When set, takes precedence over staticDir. */
  staticAssets?: Map<string, string>;
  /** Directory relative image references may reach beyond the doc's folder
   *  (#64). Default: the doc's git repository root, else the doc's folder. */
  assetRoot?: string;
  /** Remote host names accepted besides loopback (#73), e.g. a Tailscale name. */
  allowedHosts?: readonly string[];
  /** Opened by the editor for itself: an `acm` verb never picks it implicitly. */
  auxiliary?: boolean;
  /** Test seam for the external filesystem boundary. */
  appendDecisionEvent?: (docPath: string, event: DecisionEvent) => Promise<{ appended: boolean }>;
  appendDecisionEvents?: (
    docPath: string,
    events: readonly DecisionEvent[],
  ) => Promise<{ appended: number }>;
  /** Test seams for the server-owned committed-decision recovery boundary. */
  readDecisionRecoveryEvents?: (docPath: string) => Promise<DecisionEvent[]>;
  storeDecisionRecoveryEvents?: (
    docPath: string,
    events: readonly DecisionEvent[],
  ) => Promise<{ stored: number; quarantinedPath?: string }>;
  clearDecisionRecoveryEvents?: (
    docPath: string,
    events: readonly DecisionEvent[],
  ) => Promise<{ removed: number; remaining: number; quarantinedPath?: string }>;
}

export interface AcmServer {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  docPath: string;
  serverEpoch: string;
  stop: () => void;
}

/** Boot an ACM server instance against one document. Returns the running server. */
export function startServer(opts: StartServerOptions): AcmServer {
  const docPath = resolve(opts.docPath);
  const docDir = dirname(docPath);
  const docName = basename(docPath);
  const assetRoot = assetRootFor(docDir, opts.assetRoot);
  const allowedHosts = new Set(opts.allowedHosts ?? []);
  const staticDir = opts.staticDir ?? "./dist";
  const staticAssets = opts.staticAssets;
  const appendDecisionEvent = opts.appendDecisionEvent ?? appendDecisionEventToStore;
  const appendDecisionEvents =
    opts.appendDecisionEvents ??
    (opts.appendDecisionEvent
      ? async (path: string, events: readonly DecisionEvent[]) => {
          let appended = 0;
          for (const event of events) {
            if ((await appendDecisionEvent(path, event)).appended) appended += 1;
          }
          return { appended };
        }
      : appendDecisionEventsToStore);
  const readDecisionRecoveryEvents =
    opts.readDecisionRecoveryEvents ?? readDecisionRecoveryEventsFromStore;
  const storeDecisionRecoveryEvents =
    opts.storeDecisionRecoveryEvents ?? storeDecisionRecoveryEventsInStore;
  const clearDecisionRecoveryEvents =
    opts.clearDecisionRecoveryEvents ?? clearDecisionRecoveryEventsInStore;
  const { port } = opts;
  const serverEpoch = crypto.randomUUID();
  let reviewSkillServer: AcmServer | undefined;

  // ── Source-of-truth state ───────────────────────────────────────────────────
  let version = 0;
  const initialContent = safeReadText(docPath);
  let lastKnownHash = Bun.hash(initialContent);

  // Content the server held at each recent version. A writer that started from an
  // OLDER version (the editor's baseVersion, or an agent's pre-edit read) needs that
  // version's content as the merge base — so we retain a generous window. A save's
  // baseVersion is only a version or two behind the server in practice, but a burst
  // of interleaved human+agent writes can bump several versions while a save is in
  // flight, so keep plenty (prose docs are small; a few dozen copies is cheap). Past
  // the window we 409 "stale" and the editor recovers by adopting disk. The git
  // history (60s debounce) is far too coarse to serve as the merge base.
  const contentByVersion = new Map<number, string>([[0, initialContent]]);
  // What each recent editor save submitted, by the id the editor gave it. A save
  // that got no answer may still have landed: the next one names it (#128).
  const submittedBySaveId = new Map<string, { content: string; version: number }>();
  function recordVersion(content: string) {
    contentByVersion.set(version, content);
    for (const v of contentByVersion.keys()) if (v <= version - KEEP_VERSIONS) contentByVersion.delete(v);
  }

  // Latest human caret/selection reported by the editor (its buffer coords), for the
  // agent-avoids-cursor guard. Treated as stale after a few seconds of editor quiet.
  let humanSel: { from: number; to: number; at: number } | null = null;
  const PRESENCE_TTL_MS = 4000;

  // Doc history (#11): a git shadow record in <docDir>/.acm/history.git.
  // Baseline at boot, then a commit after each QUIET PERIOD of writes (saves
  // land every 500ms while typing — history entries shouldn't). Crashes lose at
  // most the last minute; agent verbs additionally snapshot before every write.
  // Declared BEFORE the route handlers that call it (no TDZ reliance).
  void recordHistory(docPath, "open");
  let historyTimer: ReturnType<typeof setTimeout> | undefined;
  const recordHistorySoon = (source: string) => {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(() => void recordHistory(docPath, source), 60_000);
  };

  // Serialize every read-check-write-version mutation (PUT, POST, watcher) so they
  // can't interleave at their `await` points and clobber each other.
  let writeChain: Promise<unknown> = Promise.resolve();
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function pushUpdate(content: string) {
    const msg: ServerMessage = { type: "update", content, version, serverEpoch };
    server.publish(DOC_TOPIC, JSON.stringify(msg));
  }

  // The SINGLE write path. Every writer — human PUT, agent CLI, in-app comment —
  // funnels through here so the conflict check fires for ALL of them; that is what
  // makes #38 (a stale writer silently clobbering another) structurally impossible.
  //   mine   — the writer's full proposed document.
  //   base   — the content the writer started from (a version snapshot, or the
  //            agent's pre-edit read), i.e. the common ancestor for the 3-way merge.
  //   guards — per-hunk fragments that MUST each survive a merge (the agent's changed
  //            line-runs). If a "clean" merge somehow dropped one, refuse to write — a
  //            belt-and-braces check against ever losing an agent edit. Per-hunk (not
  //            one contiguous span) so a multi-region agent edit isn't falsely rejected
  //            when the human concurrently edits the untouched text between its regions.
  // On divergence it 3-way merges so disjoint edits from both writers survive; only a
  // genuine same-line overlap is a conflict (nothing written). Caller holds withLock.
  type CommitResult =
    | { ok: true; content: string; version: number; decisionEvents: DecisionEvent[] }
    | { ok: false; reason: "overlap" | "containment" | "cursor"; content: string; version: number };

  interface WriteIdentity {
    author: string;
    source: ProvenanceSource;
    operation: string;
    decisionEvents?: readonly DecisionEvent[];
    /** Refuse a write that lands on the human's live caret (agent writes). */
    guardCursor?: boolean;
    /** The human editor's save keeps both sides of a same-line clash instead of
     * refusing it (#88): a refused editor save is re-sent on the same base
     * forever, so nothing typed afterwards would ever reach disk. Agent writes
     * still get "overlap" and retry. */
    keepBothOnOverlap?: boolean;
  }

  /** Does the change from `theirs` to `next` touch the human's live caret? Both
   *  are the current document, the coordinates presence is reported in: the
   *  agent's edit is compared as it would land, whatever base it was made on. */
  function touchesCaret(theirs: string, next: string): boolean {
    if (next === theirs || !humanSel || Date.now() - humanSel.at >= PRESENCE_TTL_MS) return false;
    const span = changedSpan(theirs, next);
    const lo = Math.min(humanSel.from, humanSel.to);
    const hi = Math.max(humanSel.from, humanSel.to);
    return span.from <= hi && lo <= span.to;
  }

  async function commitWrite(
    mine: string,
    base: string,
    guards: string[] | undefined,
    identity: WriteIdentity,
  ): Promise<CommitResult> {
    return withFileUpdateLock(
      documentUpdateLockPath(docPath),
      `document ${docPath}`,
      async () => {
        const theirs = await readDocText(docPath); // disk is the authoritative "theirs"
        let toWrite: string;
        if (theirs === base || mine === theirs) {
          toWrite = mine; // nobody moved under us (or we'd write exactly what's there)
        } else {
          const m = merge3(mine, base, theirs);
          let merged = m.result;
          if (!m.clean) {
            if (!identity.keepBothOnOverlap) {
              return { ok: false, reason: "overlap", content: theirs, version };
            }
            merged = mergeKeepingBoth(mine, base, theirs);
          }
          if (guards && !guards.every((g) => merged.includes(g))) {
            return { ok: false, reason: "containment", content: theirs, version };
          }
          toWrite = merged;
        }
        if (identity.guardCursor && touchesCaret(theirs, toWrite)) {
          return { ok: false, reason: "cursor", content: theirs, version };
        }
        const decisionEvents = rebaseDecisionEventsForCommit(
          identity.decisionEvents ?? [],
          { base, mine, theirs, committed: toWrite },
        );
        if (toWrite === theirs) {
          return { ok: true, content: theirs, version, decisionEvents }; // no-op
        }
        await writeDocText(docPath, toWrite); // keeps a BOM the file had (#92)
        const attribution: ProvenanceAttribution = {
          author: identity.author.trim() || "Unknown",
          source: identity.source,
          timestamp: new Date().toISOString(),
          operation: identity.operation,
        };
        try {
          await recordProvenanceWrite(
            docPath,
            theirs,
            toWrite,
            attribution,
            decisionEvents,
          );
        } catch (error) {
          console.error(`ACM warning: provenance could not be recorded: ${(error as Error).message}`);
        }
        lastKnownHash = Bun.hash(toWrite); // hash the BYTES WRITTEN so the watcher drops our echo
        version++;
        recordVersion(toWrite);
        pushUpdate(toWrite); // broadcast the FINAL (possibly merged) bytes to every client
        recordHistorySoon("edit");
        return { ok: true, content: toWrite, version, decisionEvents };
      },
    );
  }

  // Parse a JSON request body, or null when it's malformed/empty — so a bad body
  // becomes a clean 400 at the call site instead of an unhandled 500.
  async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const badJson = () => new Response("Bad request: invalid JSON", { status: 400 });
  // A wrongly typed field is refused before anything is read or written (#90): a
  // client bug must never turn into `42` or `[object Object]` on disk.
  const badField = (message: string) => new Response(`Bad request: ${message}`, { status: 400 });
  const decisionEventsFrom = (body: Record<string, unknown>): DecisionEvent[] | null => {
    if (body.decisionEvents === undefined) return [];
    if (!Array.isArray(body.decisionEvents) || !body.decisionEvents.every(isDecisionEvent)) return null;
    return body.decisionEvents;
  };
  const persistDecisionEvents = async (events: DecisionEvent[]): Promise<void> => {
    await appendDecisionEvents(docPath, events);
  };
  const retainCommittedDecisionEvents = async (events: DecisionEvent[]) => {
    const recoverable = events.filter((event) => event.source === "gui");
    if (recoverable.length === 0) {
      return { status: "skipped" as const, reason: "cli-compensation" as const };
    }
    try {
      const result = await storeDecisionRecoveryEvents(docPath, recoverable);
      return {
        status: "stored" as const,
        ...(result.quarantinedPath
          ? { quarantinedPath: result.quarantinedPath }
          : {}),
      };
    } catch (error) {
      return {
        status: "failed" as const,
        message: (error as Error).message,
      };
    }
  };
  const clearCommittedDecisionEvents = async (events: DecisionEvent[]) => {
    try {
      const result = await clearDecisionRecoveryEvents(docPath, events);
      if (result.quarantinedPath) {
        return {
          status: "quarantined" as const,
          path: result.quarantinedPath,
        };
      }
      return null;
    } catch (error) {
      return {
        status: "failed" as const,
        message: (error as Error).message,
      };
    }
  };
  const decisionDocumentMatches = (body: Record<string, unknown>): boolean =>
    body.documentPath === docPath;
  const authorFrom = (body: Record<string, unknown>, fallback: string): string =>
    typeof body.author === "string" && body.author.trim() ? body.author.trim() : fallback;
  const decisionDocumentMismatch = () =>
    Response.json(
      {
        audit: {
          status: "failed",
          code: "document-mismatch",
          retryable: false,
        },
      },
      { status: 409 },
    );

  // ── HTTP + WebSocket server ──────────────────────────────────────────────────
  // A busy port surfaces here as a thrown EADDRINUSE — we let it propagate so
  // library/CLI callers can react (the `acm` CLI catches it to auto-increment to
  // the next free port). The friendly "die with a message" treatment is applied
  // only at the direct-run entry point below (serveOrDie), not to every caller.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    // Hard body cap aligned with the asset route's 32 MB intent (plus header
    // room) — a chunked upload with no Content-Length aborts here instead of
    // buffering to Bun's 128 MB default. Prose docs are far below this.
    maxRequestBodySize: 33 * 1024 * 1024,

    async fetch(req) {
      const refused = refuseOutsideBoundary(req, allowedHosts);
      if (refused) return refused;
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (pathname === "/api/session" && req.method === "GET") {
        return Response.json({ mode: "document", path: docPath });
      }

      if (pathname === "/api/review-skill" && req.method === "GET") {
        return Response.json({ exists: findUserReviewSkill() !== null });
      }

      // POST /api/review-skill/open → open the user's review preferences in a
      // second editor. Loopback only, like the launcher (#73): the new port can't
      // be reached through a single tunnel.
      if (pathname === "/api/review-skill/open" && req.method === "POST") {
        if (!isLoopbackHost(req.headers.get("host"))) {
          return Response.json({ error: "Run acm skill on the computer running ACM." }, { status: 409 });
        }
        try {
          const create = new URL(req.url).searchParams.get("create") === "1";
          const skillPath = create ? createUserReviewSkill() : findUserReviewSkill();
          if (!skillPath) return Response.json({ error: NO_REVIEW_PREFERENCES }, { status: 404 });
          if (skillPath === docPath) return Response.json({ url: new URL(req.url).origin });
          reviewSkillServer ??= startServer({ docPath: skillPath, port: 0, staticDir, staticAssets, auxiliary: true });
          return Response.json({ url: `http://localhost:${reviewSkillServer.port}` });
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 500 });
        }
      }

      // GET /api/doc → current snapshot. `path` lets the client key per-document
      // config (the spellIgnore lists) — existing consumers destructure past it.
      if (pathname === "/api/doc" && req.method === "GET") {
        const content = await readDocText(docPath);
        return Response.json({ content, version, path: docPath, serverEpoch });
      }

      if (pathname === "/api/provenance" && req.method === "GET") {
        const content = await readDocText(docPath);
        const parsedFrom = Number(url.searchParams.get("from") ?? 0);
        const parsedTo = Number(url.searchParams.get("to") ?? content.length);
        if (!Number.isInteger(parsedFrom) || !Number.isInteger(parsedTo)) {
          return new Response("Bad request: provenance range must use integer offsets", { status: 400 });
        }
        const from = Math.max(0, Math.min(content.length, parsedFrom));
        const to = Math.max(from, Math.min(content.length, parsedTo));
        return Response.json(await readDocumentProvenanceRange(docPath, content, from, to));
      }

      // PUT /api/doc → the human editor's save. Reconciles against the base the
      // editor started from (baseVersion), so a concurrent agent write is MERGED in
      // rather than clobbered. Returns the final (possibly merged) content for the
      // editor to adopt; commitWrite broadcasts it to any other clients.
      if (pathname === "/api/doc" && req.method === "PUT") {
        const body = await jsonBody(req);
        if (!body) return badJson();
        const decisionEvents = decisionEventsFrom(body);
        if (!decisionEvents) return new Response("Bad request: invalid decision events", { status: 400 });
        if (!decisionDocumentMatches(body)) return decisionDocumentMismatch();
        if (body.serverEpoch !== serverEpoch) {
          return Response.json({ conflict: "server-epoch" }, { status: 409 });
        }
        const { content, baseVersion } = body;
        if (typeof content !== "string") return badField("content must be a string");
        // Memory never holds a BOM (GET strips it, disk keeps the file's own: #92).
        if (startsWithBomChar(content)) return badField("content must not start with a BOM");
        if (!Number.isInteger(baseVersion)) return badField("baseVersion must be an integer");
        const saveId = typeof body.saveId === "string" ? body.saveId : undefined;
        const unansweredSaveIds = Array.isArray(body.unansweredSaveIds)
          ? body.unansweredSaveIds.filter((id): id is string => typeof id === "string").slice(-KEEP_VERSIONS)
          : [];
        return withLock(async () => {
          // The editor's buffer descends from what its newest landed save submitted,
          // which is not what that save became if the server merged another writer in.
          // A baseVersion at or past that save means the editor has moved on from it.
          const landedSave = unansweredSaveIds
            .map((id) => submittedBySaveId.get(id))
            .findLast((save) => save !== undefined && save.version > (baseVersion as number));
          const base = landedSave?.content ?? contentByVersion.get(baseVersion as number);
          if (base === undefined) {
            // Too far behind to reconstruct a merge base (rare given 500ms saves).
            // Refuse rather than guess; the editor adopts disk and the user re-applies.
            const disk = await readDocText(docPath);
            return Response.json({ content: disk, version, conflict: "stale" }, { status: 409 });
          }
          const r = await commitWrite(content, base, undefined, {
            author: authorFrom(body, "You"),
            source: "human",
            operation: "edit",
            decisionEvents,
            keepBothOnOverlap: true,
          });
          if (!r.ok) return Response.json({ content: r.content, version: r.version, conflict: r.reason }, { status: 409 });
          if (saveId) {
            submittedBySaveId.set(saveId, { content, version: r.version });
            if (submittedBySaveId.size > KEEP_VERSIONS) submittedBySaveId.delete(submittedBySaveId.keys().next().value!);
          }
          try {
            await persistDecisionEvents(r.decisionEvents);
          } catch {
            const recovery = await retainCommittedDecisionEvents(r.decisionEvents);
            return Response.json(
              {
                version: r.version,
                content: r.content,
                audit: {
                  status: "failed",
                  code: "decision-persistence",
                  retryable: true,
                  decisionEvents: r.decisionEvents,
                  recovery,
                },
              },
              { status: 500 },
            );
          }
          const recovery = await clearCommittedDecisionEvents(r.decisionEvents);
          return Response.json({
            version: r.version,
            content: r.content,
            ...(decisionEvents.length > 0
              ? {
                  audit: {
                    status: "persisted",
                    decisionEventIds: r.decisionEvents.map((event) => event.id),
                    ...(recovery ? { recovery } : {}),
                  },
                }
              : {}),
          });
        });
      }

      // Durable, inspectable audit history for successful review decisions.
      if (pathname === "/api/decisions" && req.method === "POST") {
        const body = await jsonBody(req);
        if (!body) return badJson();
        const decisionEvents = decisionEventsFrom(body);
        if (!decisionEvents) {
          return new Response("Bad request: invalid decision events", { status: 400 });
        }
        if (!decisionDocumentMatches(body)) return decisionDocumentMismatch();
        return withLock(async () => {
          try {
            await persistDecisionEvents(decisionEvents);
          } catch (err) {
            const recovery = await retainCommittedDecisionEvents(decisionEvents);
            return Response.json(
              {
                audit: {
                  status: "failed",
                  code: "decision-persistence",
                  retryable: true,
                  decisionEvents,
                  message: (err as Error).message,
                  recovery,
                },
              },
              { status: 500 },
            );
          }
          const recovery = await clearCommittedDecisionEvents(decisionEvents);
          return Response.json({
            audit: {
              status: "persisted",
              decisionEventIds: decisionEvents.map((event) => event.id),
              ...(recovery ? { recovery } : {}),
            },
          });
        });
      }

      if (pathname === "/api/decisions" && req.method === "GET") {
        try {
          const history = await readDecisionHistory(docPath);
          return Response.json({
            decisionEvents: history.decisionEvents,
            ...(history.issues.length > 0 ? { decisionHistoryIssues: history.issues } : {}),
          });
        } catch (err) {
          return Response.json(
            { error: { code: "decision-history-unreadable", message: (err as Error).message } },
            { status: 500 },
          );
        }
      }

      if (pathname === "/api/decision-recovery" && req.method === "GET") {
        try {
          return Response.json({
            decisionEvents: await readDecisionRecoveryEvents(docPath),
          });
        } catch (error) {
          return Response.json(
            {
              error: {
                code: "decision-recovery-unreadable",
                message: (error as Error).message,
              },
            },
            { status: 500 },
          );
        }
      }

      // POST /api/comment → in-app comment via the shared grammar. `anchor` is either
      // a unique prose span (wrapped `{==span==}`, comment after it — the same rule as
      // `acm comment`) or an integer offset for a point comment. Anything it can't place
      // exactly is refused (#49: never write an unanchored comment at offset 0). Reads
      // under the lock, so its base == disk → commitWrite takes the fast path; routed
      // through it anyway for one consistent hash/broadcast path.
      if (pathname === "/api/comment" && req.method === "POST") {
        const body = await jsonBody(req);
        if (!body) return badJson();
        if (!decisionDocumentMatches(body)) return decisionDocumentMismatch();
        const { anchor, text, author } = body as { anchor: unknown; text: unknown; author: unknown };
        if (author !== undefined && typeof author !== "string") return badField("author must be a string");
        const commentAuthor = authorFrom(body, "You"); // one resolved author for the marker and provenance
        if (typeof text !== "string" || !text) {
          return new Response("Bad request: text must be a non-empty string", { status: 400 });
        }
        if (!(typeof anchor === "string" && anchor) && !(Number.isInteger(anchor) && (anchor as number) >= 0)) {
          return new Response(
            "Bad request: anchor must be a unique text span or a character offset",
            { status: 400 },
          );
        }
        return withLock(async () => {
          const before = await readDocText(docPath);
          let next: string;
          if (typeof anchor === "string") {
            try {
              next = addAnchoredComment(before, anchor, commentAuthor, text);
            } catch (err) {
              return Response.json(
                { error: { code: "anchor-not-unique", message: (err as Error).message } },
                { status: 422 },
              );
            }
          } else {
            if ((anchor as number) > before.length) {
              return new Response("Bad request: anchor offset is past the end of the document", { status: 400 });
            }
            next = insertComment(before, anchor as number, text, commentAuthor);
          }
          const r = await commitWrite(next, before, undefined, {
            author: commentAuthor,
            source: "human",
            operation: "comment",
          });
          if (!r.ok) return Response.json({ conflict: r.reason }, { status: 409 });
          return Response.json({ version: r.version });
        });
      }

      // POST /api/agent-write → the `acm` CLI routes its rewrite here when this doc
      // is open in an editor (issue #38). `base` is the CLI's pre-edit read; the
      // server 3-way merges it against disk so the human's concurrent edits and the
      // agent's card both survive. Two guards before writing: (1) the cursor guard
      // declines a write that lands on the human's live caret; (2) commitWrite's
      // containment check refuses any merge that dropped the agent's inserted marker.
      if (pathname === "/api/agent-write" && req.method === "POST") {
        const body = await jsonBody(req);
        if (!body) return badJson();
        const decisionEvents = decisionEventsFrom(body);
        if (!decisionEvents) return new Response("Bad request: invalid decision events", { status: 400 });
        if (!decisionDocumentMatches(body)) return decisionDocumentMismatch();
        const { base, content } = body;
        if (typeof base !== "string" || typeof content !== "string") {
          return badField("base and content must be strings");
        }
        if (startsWithBomChar(base) || startsWithBomChar(content)) {
          return badField("base and content must not start with a BOM");
        }
        return withLock(async () => {
          const r = await commitWrite(content, base, changedFragments(base, content), {
            guardCursor: true, // checked under the file lock, on the write's own snapshot (#98, #115)
            author: authorFrom(body, "Agent"),
            source: body.source === "restore" ? "restore" : "agent", // `acm restore` (#100)
            operation: typeof body.operation === "string" && body.operation.trim()
              ? body.operation.trim()
              : "agent edit",
            decisionEvents,
          });
          if (!r.ok) return Response.json({ conflict: r.reason }, { status: 409 });
          try {
            await persistDecisionEvents(r.decisionEvents);
          } catch {
            return Response.json(
              {
                version: r.version,
                content: r.content,
                audit: {
                  status: "failed",
                  code: "decision-persistence",
                  retryable: true,
                  decisionEvents: r.decisionEvents,
                },
              },
              { status: 500 },
            );
          }
          return Response.json({
            version: r.version,
            content: r.content,
            ...(decisionEvents.length > 0
              ? {
                  audit: {
                    status: "persisted",
                    decisionEventIds: r.decisionEvents.map((event) => event.id),
                  },
                }
              : {}),
          });
        });
      }

      // PUT /api/presence → the editor reports its live caret/selection so agent
      // writes can steer clear of it. Advisory only — the merge is the guarantee.
      if (pathname === "/api/presence" && req.method === "PUT") {
        const body = await jsonBody(req);
        if (!body) return badJson();
        const { from, to } = body;
        if (!Number.isInteger(from) || !Number.isInteger(to)) return badField("from and to must be integers");
        humanSel = { from: from as number, to: to as number, at: Date.now() };
        return Response.json({ ok: true });
      }

      // GET /api/asset?path=<rel> → serve an image the doc references by
      // relative path (issues #3, #64). Any path under the doc's folder or the
      // asset root (default: the doc's git repo) is fair game — so
      // ![](figures/plot.png) and ![](../../org/docs/x.png) render; anything
      // outside is refused with 403 (the client shows "blocked", not "missing").
      if (pathname === "/api/asset" && req.method === "GET") {
        const rel = url.searchParams.get("path") ?? "";
        const asset = resolveAsset(assetRoot, docDir, rel);
        if (!asset.ok) {
          const why = asset.reason === "not-image" ? "not an image type" : `outside the asset root ${assetRoot}`;
          return new Response(`Blocked: ${why}`, { status: 403 });
        }
        const file = Bun.file(asset.path);
        if (!(await file.exists())) return new Response("Not found", { status: 404 });
        // CSP sandbox: an on-disk SVG (or anything else) opened directly from
        // this route must never run scripts on the app's origin. <img> rendering
        // is unaffected. ACM-managed assets are content-addressed (stem-hash8),
        // hence immutable — cache them hard so scrolling a doc with big
        // screenshots doesn't refetch full bodies on every viewport re-entry.
        const headers: Record<string, string> = { "Content-Security-Policy": "sandbox" };
        if (/^assets\/[^/]+-[0-9a-f]{8}\.[a-z0-9]+$/.test(rel))
          headers["Cache-Control"] = "public, max-age=31536000, immutable";
        return new Response(file, { headers });
      }

      // POST /api/asset?name=<orig> (raw image bytes as body) → save under
      // <docDir>/assets/ with a content-addressed name; returns { path } for the
      // markdown reference. Images only — the reject decision is enforced here,
      // not just in the client filter. No doc write happens here: the editor
      // inserts the returned path through the normal save path.
      if (pathname === "/api/asset" && req.method === "POST") {
        const name = url.searchParams.get("name") ?? "";
        // Cap the upload BEFORE buffering it — the route is network-reachable
        // and req.arrayBuffer() would otherwise hold an unbounded body in
        // memory. Checked again after (Content-Length can lie / be absent).
        const MAX_ASSET_BYTES = 32 * 1024 * 1024; // generous for any screenshot
        if (Number(req.headers.get("content-length") ?? 0) > MAX_ASSET_BYTES)
          return new Response("Image too large (32 MB max)", { status: 413 });
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.length > MAX_ASSET_BYTES) return new Response("Image too large (32 MB max)", { status: 413 });
        if (bytes.length === 0) return new Response("Empty body", { status: 400 });
        const saved = await saveAsset(docDir, name, bytes);
        if (!saved)
          return new Response(`Unsupported file — images only (${IMAGE_EXTS_LABEL}), bytes must match`, {
            status: 415,
          });
        return Response.json(saved);
      }

      // GET /api/settings → persisted view settings + per-document "seen" state (or {} on a
      // fresh install). The browser keeps localStorage as an instant cache; this
      // file is the source of truth across instances/restarts.
      if (pathname === "/api/settings" && req.method === "GET") {
        return Response.json(await readConfig<Record<string, unknown>>(SETTINGS_FILE, {}));
      }

      // PUT /api/settings → MERGE a partial patch ({settings} or one
      // {seenByDocument} slice) into the stored config. Nested seen slices merge
      // one level deep so open documents do not clobber each other's state.
      // Serialized via withLock so concurrent patches can't lose a read-modify-write.
      if (pathname === "/api/settings" && req.method === "PUT") {
        const patch = await jsonBody(req);
        if (!patch) return badJson();
        return withLock(async () => {
          await updateConfig<Record<string, unknown>>(SETTINGS_FILE, {}, (current) =>
            mergeConfigPatch(current, patch),
          );
          return Response.json({ ok: true });
        });
      }

      return serveAppAsset(pathname, staticDir, staticAssets);
    },

    websocket: {
      open(ws) {
        ws.subscribe(DOC_TOPIC);
      },
      close(ws) {
        ws.unsubscribe(DOC_TOPIC);
      },
      message() {
        // Clients are receive-only; writes go through the HTTP API.
      },
    },
  });

  // ── File watching (the correctness core) ────────────────────────────────────
  // Watch the CONTAINING DIRECTORY non-recursively: atomic temp-then-rename saves
  // deafen a file-inode-bound watcher. Filter to our basename, debounce, re-read +
  // re-hash, and drop the event when the hash matches our own last write.
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const watcher: FSWatcher = watch(docDir, async (_event, filename) => {
    if (filename !== docName) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      void withLock(async () => {
        const file = Bun.file(docPath);
        if (!(await file.exists())) return; // mid-rename — wait for the next event
        const content = await readDocText(docPath);
        const hash = Bun.hash(content);
        if (hash === lastKnownHash) return; // our own write — drop the echo
        const before = contentByVersion.get(version) ?? content;
        try {
          await recordProvenanceWrite(docPath, before, content, {
            author: "External edit",
            source: "external",
            timestamp: new Date().toISOString(),
            operation: "external edit",
          });
        } catch (error) {
          console.error(`ACM warning: external-edit provenance could not be recorded: ${(error as Error).message}`);
        }
        lastKnownHash = hash;
        version++;
        recordVersion(content); // so a later in-flight save can merge against it
        pushUpdate(content);
        recordHistorySoon("external edit");
      });
    }, 100);
  });

  const boundPort = server.port ?? port;
  console.log(`ACM server on http://localhost:${boundPort} — doc: ${docPath}`);

  // Register in ~/.config/acm/instances.json so `acm` verbs can resolve "the doc
  // open in the editor" without --doc/ACM_DOC. Fire-and-forget; liveness (pid
  // probing) is the authority, so no unregister-on-exit bookkeeping is needed.
  void registerInstance(boundPort, docPath, opts.auxiliary).catch(() => {
    console.error(
      "ACM warning: could not update the optional running-instance registry.",
    );
  });


  return {
    server,
    port: boundPort,
    docPath,
    serverEpoch,
    stop: () => {
      reviewSkillServer?.stop();
      watcher.close();
      if (debounce) clearTimeout(debounce);
      if (historyTimer) clearTimeout(historyTimer);
      void recordHistory(docPath, "close"); // best-effort final history entry
      server.stop();
    },
  };
}

/** Read a file's text without a leading BOM (#92), or "" if it doesn't exist yet
 *  (a brand-new doc). Sync: it seeds version 0 before the server starts. */
function safeReadText(path: string): string {
  try {
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

/**
 * Run a server-start thunk, turning a startup EADDRINUSE into a friendly message +
 * clean exit instead of a raw stack trace. Any OTHER error is rethrown unchanged
 * so genuinely unexpected failures still surface their stack. We don't assume WHO
 * holds the port (another ACM, a stale background process, or an unrelated app) —
 * best-effort `lsof` the pid to show, then suggest the two generic fixes. Used
 * only at the direct-run entry point — callers that want to recover from a busy
 * port (e.g. the CLI's port auto-increment) call startServer() and catch instead.
 */
function serveOrDie<T>(port: number, serve: () => T): T {
  try {
    return serve();
  } catch (err) {
    if ((err as { code?: string })?.code !== "EADDRINUSE") throw err;
    process.stderr.write(`\n✗ Port ${port} is already in use.\n`);
    const pid = pidOnPort(port);
    if (pid) process.stderr.write(`  Held by process ${pid}.\n`);
    process.stderr.write(
      `\nEither stop whatever is on that port:\n` +
        `  lsof -ti:${port} | xargs kill\n` +
        `or run ACM on a different port:\n` +
        `  ACM_PORT=${port + 1} bun run start   (or: just prod)\n\n`,
    );
    process.exit(1);
  }
}

/** Best-effort pid of the process listening on `port` via `lsof`, or null if
 *  lsof is missing / errors / nothing is listening. Never throws. */
function pidOnPort(port: number): string | null {
  try {
    const { stdout, exitCode } = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`]);
    if (exitCode !== 0) return null;
    const pid = stdout.toString().trim().split("\n")[0]?.trim();
    return pid || null;
  } catch {
    return null;
  }
}

// ── Dev / `bun run start` entry: boot from env (back-compat with bun run dev) ──
// Only runs when this file is executed directly, not when imported by cli.ts.
// No doc means refuse, never a silent fallback to the repo seed (#33): serving
// the bundled stub instead of your document looks exactly like lost work.
if (import.meta.main) {
  const docArg = process.env.ACM_DOC?.trim();
  if (!docArg) {
    process.stderr.write(
      "\n✗ ACM: no document — set ACM_DOC to the .md file to edit:\n" +
        "  ACM_DOC=/path/to/doc.md bun run start   (or: just prod /path/to/doc.md, acm edit doc.md)\n\n",
    );
    process.exit(2);
  }
  const port = Number(process.env.ACM_PORT ?? 12000);
  const assetRoot = process.env.ACM_ASSET_ROOT?.trim() || undefined;
  const allowedHosts = resolveAllowedHosts({ flags: [], env: process.env.ACM_ALLOWED_HOSTS, detect: tailscaleDnsName });
  const acm = serveOrDie(port, () => startServer({ docPath: docArg, port, assetRoot, allowedHosts }));
  const remote = allowedHosts.length ? `\n  also allowed: ${allowedHosts.join(", ")}` : "";
  console.log(`\n  ACM ready → http://localhost:${acm.port}\n  editing: ${acm.docPath}${remote}\n`);
}
