export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return originUrl.protocol === "http:" && originUrl.host.toLowerCase() === req.headers.get("host")?.toLowerCase();
  } catch {
    return false;
  }
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
