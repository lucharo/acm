import { resolve } from "node:path";
import { readConfig, SETTINGS_FILE, updateConfig } from "./config";
import { prepareDocumentTarget } from "./documentTarget";
import { refuseOutsideBoundary, serveAppAsset } from "./http";
import { listRecentDocuments } from "./recent";
import { mergeConfigPatch } from "../lib/seenState";

export interface StartLauncherOptions {
  port: number;
  cwd: string;
  staticDir?: string;
  staticAssets?: Map<string, string>;
  activateDocument: (documentPath: string, created: boolean) => Promise<{ url: string }>;
}

export interface AcmLauncherServer {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  cwd: string;
  stop: () => void;
}

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function startLauncherServer(opts: StartLauncherOptions): AcmLauncherServer {
  const cwd = resolve(opts.cwd);
  const staticDir = opts.staticDir ?? "./dist";
  // Loopback only, even with allowed remote hosts (#73): opening a document
  // moves to a new port, which a single tunnel (tailscale serve) can't follow.
  const allowedHosts = new Set<string>();
  let opening = false;
  let settingsWriteChain: Promise<unknown> = Promise.resolve();
  const withSettingsLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = settingsWriteChain.then(fn, fn);
    settingsWriteChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    maxRequestBodySize: 64 * 1024,
    async fetch(req) {
      const refused = refuseOutsideBoundary(req, allowedHosts);
      if (refused) return refused;
      const { pathname } = new URL(req.url);
      if (pathname === "/api/session" && req.method === "GET") {
        return Response.json({ mode: "launcher", cwd, recent: await listRecentDocuments() });
      }
      if (pathname === "/api/settings" && req.method === "GET") {
        return Response.json(await readConfig<Record<string, unknown>>(SETTINGS_FILE, {}));
      }
      if (pathname === "/api/settings" && req.method === "PUT") {
        const patch = await jsonBody(req);
        if (!patch) return new Response("Bad request: invalid JSON", { status: 400 });
        return withSettingsLock(async () => {
          await updateConfig<Record<string, unknown>>(SETTINGS_FILE, {}, (current) =>
            mergeConfigPatch(current, patch),
          );
          return Response.json({ ok: true });
        });
      }
      if (pathname === "/api/launcher/open" && req.method === "POST") {
        if (opening) return Response.json({ error: "A document is already opening." }, { status: 409 });
        const body = await jsonBody(req);
        if (!body || typeof body.path !== "string" || typeof body.create !== "boolean") {
          return Response.json({ error: "Expected a path and New/Open choice." }, { status: 400 });
        }
        const target = prepareDocumentTarget(body.path, cwd, body.create ? "create" : "open");
        if (!target.ok) return Response.json({ error: target.message }, { status: target.status });
        opening = true;
        try {
          const activated = await opts.activateDocument(target.path, target.created);
          return Response.json({ url: activated.url, path: target.path, created: target.created });
        } catch (error) {
          opening = false;
          return Response.json(
            { error: `ACM could not open the document: ${(error as Error).message}` },
            { status: 500 },
          );
        }
      }
      if (pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
      return serveAppAsset(pathname, staticDir, opts.staticAssets);
    },
  });
  const port = server.port ?? opts.port;
  console.log(`ACM launcher on http://localhost:${port} — folder: ${cwd}`);
  return { server, port, cwd, stop: () => server.stop() };
}
