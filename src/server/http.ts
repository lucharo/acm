// ── Request boundary ──────────────────────────────────────────────────────────
// ACM binds 127.0.0.1 and refuses any request whose Host isn't loopback — the
// DNS-rebinding guard — unless the Host names an explicitly allowed remote host
// (#73: `tailscale serve` forwarding https://<mac>.<tailnet>.ts.net to loopback).
// Allowed hosts come from `acm edit --allow-host`, ACM_ALLOWED_HOSTS, or by
// default the machine's Tailscale MagicDNS name when Tailscale is up.

export function isLoopbackHost(host: string | null): boolean {
  return isAllowedHost(host, new Set());
}

function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Loopback, or a host name (any port) in `allowed`. */
export function isAllowedHost(host: string | null, allowed: ReadonlySet<string>): boolean {
  if (!host) return false;
  const hostname = hostnameOf(host);
  if (!hostname) return false;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || allowed.has(hostname);
}

/** Same-origin: no Origin, or an Origin whose host equals the Host header, over
 *  http — or https when that host is an allowed remote host (tailscale serve). */
export function isAllowedOrigin(req: Request, allowed: ReadonlySet<string> = new Set()): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    if (originUrl.host.toLowerCase() !== req.headers.get("host")?.toLowerCase()) return false;
    return originUrl.protocol === "http:" || (originUrl.protocol === "https:" && allowed.has(originUrl.hostname.toLowerCase()));
  } catch {
    return false;
  }
}

/** The 403 for a request outside the boundary, or null to let it through. */
export function refuseOutsideBoundary(req: Request, allowed: ReadonlySet<string>): Response | null {
  if (!isAllowedHost(req.headers.get("host"), allowed)) {
    return new Response(
      "Forbidden: ACM accepts loopback requests only (for remote access: acm edit <file> --allow-host <name>, or ACM_ALLOWED_HOSTS)",
      { status: 403 },
    );
  }
  if (!isAllowedOrigin(req, allowed)) {
    return new Response("Forbidden: cross-origin requests are not allowed", { status: 403 });
  }
  return null;
}

/** Host names from --allow-host values / ACM_ALLOWED_HOSTS (comma or space
 *  separated), lowercased, without a trailing dot. */
export function parseAllowedHosts(values: readonly string[]): string[] {
  return values
    .flatMap((v) => v.split(/[\s,]+/))
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

/** --allow-host flags win; else ACM_ALLOWED_HOSTS (set but empty opts out of the
 *  default); else the Tailscale MagicDNS name when Tailscale is up. */
export function resolveAllowedHosts(opts: {
  flags: readonly string[];
  env: string | undefined;
  detect: () => string | null;
}): string[] {
  if (opts.flags.length) return parseAllowedHosts(opts.flags);
  if (opts.env !== undefined) return parseAllowedHosts([opts.env]);
  const name = opts.detect();
  return name ? parseAllowedHosts([name]) : [];
}

export async function serveAppAsset(
  pathname: string,
  staticDir: string,
  staticAssets?: Map<string, string>,
): Promise<Response> {
  const urlKey = pathname === "/" ? "/index.html" : pathname;
  if (staticAssets) {
    const filePath = staticAssets.get(urlKey) ?? staticAssets.get("/index.html");
    return filePath ? new Response(Bun.file(filePath)) : new Response("Not found", { status: 404 });
  }
  const asset = Bun.file(`${staticDir}${urlKey}`);
  if (await asset.exists()) return new Response(asset);
  return new Response(Bun.file(`${staticDir}/index.html`));
}
