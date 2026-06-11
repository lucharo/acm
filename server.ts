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
import { readConfig, writeConfig } from "./src/server/config";
import { registerInstance } from "./src/server/instances";

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
  let lastKnownHash = Bun.hash(safeReadText(docPath));

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

  // ── HTTP + WebSocket server ──────────────────────────────────────────────────
  const server = Bun.serve({
    port,

    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // GET /api/doc → current snapshot.
      if (pathname === "/api/doc" && req.method === "GET") {
        const content = await Bun.file(docPath).text();
        return Response.json({ content, version });
      }

      // PUT /api/doc → version-checked human write. NO broadcast (the writer already
      // has the content; the hash gate suppresses the watcher echo).
      if (pathname === "/api/doc" && req.method === "PUT") {
        const { content, baseVersion } = (await req.json()) as {
          content: string;
          baseVersion: number;
        };
        return withLock(async () => {
          if (baseVersion !== version) {
            const currentFileContent = await Bun.file(docPath).text();
            return Response.json({ content: currentFileContent, version }, { status: 409 });
          }
          await Bun.write(docPath, content);
          lastKnownHash = Bun.hash(content);
          version++;
          return Response.json({ version });
        });
      }

      // POST /api/comment → agent drops a comment via the shared grammar.
      if (pathname === "/api/comment" && req.method === "POST") {
        const { anchor, text, author } = (await req.json()) as {
          anchor: number;
          text: string;
          author: string;
        };
        return withLock(async () => {
          const content = await Bun.file(docPath).text();
          const next = insertComment(content, anchor, text, author);
          await Bun.write(docPath, next);
          lastKnownHash = Bun.hash(next);
          version++;
          pushUpdate(next);
          return Response.json({ version });
        });
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
        const patch = (await req.json()) as Record<string, unknown>;
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
        pushUpdate(content);
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

// ── Dev / `bun run start` entry: boot from env (back-compat with bun run dev) ──
// Only runs when this file is executed directly, not when imported by cli.ts.
if (import.meta.main) {
  startServer({
    docPath: process.env.ACM_DOC ?? "seed/sample-essay.md",
    port: Number(process.env.ACM_PORT ?? 12000),
  });
}
