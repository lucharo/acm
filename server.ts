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
import { merge3, changedSpan, changedFragments } from "./src/lib/merge";
import { readConfig, writeConfig } from "./src/server/config";
import { registerInstance } from "./src/server/instances";
import { recordHistory } from "./src/server/history";
import { saveAsset, resolveUnderDocDir } from "./src/server/asset";
import { IMAGE_EXTS_LABEL } from "./src/lib/imageTypes";

const SETTINGS_FILE = "settings.json";

const DOC_TOPIC = "doc";

export interface StartServerOptions {
  /** Absolute or relative path to the CriticMarkup .md doc (the source of truth). */
  docPath: string;
  /** Port to listen on. */
  port: number;
  /** Directory holding the built SPA to serve in production (default ./dist). */
  staticDir?: string;
  /** Embedded SPA assets (url-path → bun file path) — used by the compiled binary
   *  / `bun link` install. When set, takes precedence over staticDir. */
  staticAssets?: Map<string, string>;
}

export interface AcmServer {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  docPath: string;
  stop: () => void;
}

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // CLI/curl requests are local but do not send Origin.
  try {
    const originUrl = new URL(origin);
    return originUrl.protocol === "http:" && originUrl.host.toLowerCase() === req.headers.get("host")?.toLowerCase();
  } catch {
    return false;
  }
}

/** Boot an ACM server instance against one document. Returns the running server. */
export function startServer(opts: StartServerOptions): AcmServer {
  const docPath = resolve(opts.docPath);
  const docDir = dirname(docPath);
  const docName = basename(docPath);
  const staticDir = opts.staticDir ?? "./dist";
  const staticAssets = opts.staticAssets;
  const { port } = opts;

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
  const KEEP_VERSIONS = 32;
  const contentByVersion = new Map<number, string>([[0, initialContent]]);
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
    const msg: ServerMessage = { type: "update", content, version };
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
    | { ok: true; content: string; version: number }
    | { ok: false; reason: "overlap" | "containment"; content: string; version: number };

  async function commitWrite(mine: string, base: string, guards?: string[]): Promise<CommitResult> {
    const theirs = await Bun.file(docPath).text(); // disk is the authoritative "theirs"
    let toWrite: string;
    if (theirs === base || mine === theirs) {
      toWrite = mine; // nobody moved under us (or we'd write exactly what's there)
    } else {
      const m = merge3(mine, base, theirs);
      if (!m.clean) return { ok: false, reason: "overlap", content: theirs, version };
      if (guards && !guards.every((g) => m.result.includes(g)))
        return { ok: false, reason: "containment", content: theirs, version };
      toWrite = m.result;
    }
    if (toWrite === theirs) return { ok: true, content: theirs, version }; // no-op
    await Bun.write(docPath, toWrite);
    lastKnownHash = Bun.hash(toWrite); // hash the BYTES WRITTEN so the watcher drops our echo
    version++;
    recordVersion(toWrite);
    pushUpdate(toWrite); // broadcast the FINAL (possibly merged) bytes to every client
    recordHistorySoon("edit");
    return { ok: true, content: toWrite, version };
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
      if (!isLoopbackHost(req.headers.get("host"))) {
        return new Response("Forbidden: ACM accepts loopback requests only", { status: 403 });
      }
      if (!isAllowedOrigin(req)) {
        return new Response("Forbidden: cross-origin requests are not allowed", { status: 403 });
      }
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // GET /api/doc → current snapshot. `path` lets the client key per-document
      // config (the spellIgnore lists) — existing consumers destructure past it.
      if (pathname === "/api/doc" && req.method === "GET") {
        const content = await Bun.file(docPath).text();
        return Response.json({ content, version, path: docPath });
      }

      // PUT /api/doc → the human editor's save. Reconciles against the base the
      // editor started from (baseVersion), so a concurrent agent write is MERGED in
      // rather than clobbered. Returns the final (possibly merged) content for the
      // editor to adopt; commitWrite broadcasts it to any other clients.
      if (pathname === "/api/doc" && req.method === "PUT") {
        const body = await jsonBody(req);
        if (!body) return badJson();
        const { content, baseVersion } = body as { content: string; baseVersion: number };
        return withLock(async () => {
          const base = contentByVersion.get(baseVersion);
          if (base === undefined) {
            // Too far behind to reconstruct a merge base (rare given 500ms saves).
            // Refuse rather than guess; the editor adopts disk and the user re-applies.
            const disk = await Bun.file(docPath).text();
            return Response.json({ content: disk, version, conflict: "stale" }, { status: 409 });
          }
          const r = await commitWrite(content, base);
          if (!r.ok) return Response.json({ content: r.content, version: r.version, conflict: r.reason }, { status: 409 });
          return Response.json({ version: r.version, content: r.content });
        });
      }

      // POST /api/comment → in-app comment via the shared grammar. Reads under the
      // lock, so its base == disk → commitWrite takes the fast path; routed through
      // it anyway for one consistent hash/broadcast path.
      if (pathname === "/api/comment" && req.method === "POST") {
        const body = await jsonBody(req);
        if (!body) return badJson();
        const { anchor, text, author } = body as { anchor: number; text: string; author: string };
        return withLock(async () => {
          const before = await Bun.file(docPath).text();
          const next = insertComment(before, anchor, text, author);
          const r = await commitWrite(next, before);
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
        const { base, content } = body as { base: string; content: string };
        return withLock(async () => {
          const span = changedSpan(base, content);
          if (humanSel && Date.now() - humanSel.at < PRESENCE_TTL_MS) {
            const lo = Math.min(humanSel.from, humanSel.to);
            const hi = Math.max(humanSel.from, humanSel.to);
            if (span.from <= hi && lo <= span.to) {
              return Response.json({ conflict: "cursor" }, { status: 409 });
            }
          }
          const r = await commitWrite(content, base, changedFragments(base, content));
          if (!r.ok) return Response.json({ conflict: r.reason }, { status: 409 });
          return Response.json({ version: r.version, content: r.content });
        });
      }

      // PUT /api/presence → the editor reports its live caret/selection so agent
      // writes can steer clear of it. Advisory only — the merge is the guarantee.
      if (pathname === "/api/presence" && req.method === "PUT") {
        const body = await jsonBody(req);
        if (!body) return badJson();
        const { from, to } = body as { from: number; to: number };
        humanSel = { from, to, at: Date.now() };
        return Response.json({ ok: true });
      }

      // GET /api/asset?path=<rel> → serve a file the doc references by relative
      // path (issue #3). Any path UNDER the doc's directory is fair game — not
      // just assets/ — so hand-written references like ![](figures/plot.png)
      // render; anything resolving above docDir is refused (traversal guard).
      if (pathname === "/api/asset" && req.method === "GET") {
        const rel = url.searchParams.get("path") ?? "";
        const abs = resolveUnderDocDir(docDir, rel);
        if (!abs) return new Response("Forbidden", { status: 403 });
        const file = Bun.file(abs);
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

      // GET /api/settings → persisted view settings + "seen" state (or {} on a
      // fresh install). The browser keeps localStorage as an instant cache; this
      // file is the source of truth across instances/restarts.
      if (pathname === "/api/settings" && req.method === "GET") {
        return Response.json(await readConfig<Record<string, unknown>>(SETTINGS_FILE, {}));
      }

      // PUT /api/settings → MERGE a partial patch ({settings} or {seen}) into the
      // stored config. Merge (not replace) so the two independent client writers —
      // settings (App) and seen (Workspace) — never clobber each other's key.
      // Serialized via withLock so concurrent patches can't lose a read-modify-write.
      if (pathname === "/api/settings" && req.method === "PUT") {
        const patch = await jsonBody(req);
        if (!patch) return badJson();
        return withLock(async () => {
          const current = await readConfig<Record<string, unknown>>(SETTINGS_FILE, {});
          await writeConfig(SETTINGS_FILE, { ...current, ...patch });
          return Response.json({ ok: true });
        });
      }

      // Production: serve the SPA. Prefer embedded assets (compiled binary / bun
      // link); else the filesystem staticDir. SPA fallback → index.html.
      const urlKey = pathname === "/" ? "/index.html" : pathname;
      if (staticAssets) {
        const filePath = staticAssets.get(urlKey) ?? staticAssets.get("/index.html");
        return filePath ? new Response(Bun.file(filePath)) : new Response("Not found", { status: 404 });
      }
      const asset = Bun.file(`${staticDir}${urlKey}`);
      if (await asset.exists()) return new Response(asset);
      return new Response(Bun.file(`${staticDir}/index.html`));
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
        const content = await file.text();
        const hash = Bun.hash(content);
        if (hash === lastKnownHash) return; // our own write — drop the echo
        lastKnownHash = hash;
        version++;
        recordVersion(content); // so a later in-flight save can merge against it
        pushUpdate(content);
        recordHistorySoon("agent edit");
      });
    }, 100);
  });

  console.log(`ACM server on http://localhost:${port} — doc: ${docPath}`);

  // Register in ~/.config/acm/instances.json so `acm` verbs can resolve "the doc
  // open in the editor" without --doc/ACM_DOC. Fire-and-forget; liveness (pid
  // probing) is the authority, so no unregister-on-exit bookkeeping is needed.
  void registerInstance(port, docPath);


  return {
    server,
    port,
    docPath,
    stop: () => {
      watcher.close();
      if (debounce) clearTimeout(debounce);
      if (historyTimer) clearTimeout(historyTimer);
      void recordHistory(docPath, "close"); // best-effort final history entry
      server.stop();
    },
  };
}

/** Read a file's text, or "" if it doesn't exist yet (a brand-new doc). */
function safeReadText(path: string): string {
  try {
    return readFileSync(path, "utf8");
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
if (import.meta.main) {
  const port = Number(process.env.ACM_PORT ?? 12000);
  serveOrDie(port, () =>
    startServer({
      docPath: process.env.ACM_DOC ?? "seed/sample-essay.md",
      port,
    }),
  );
}
