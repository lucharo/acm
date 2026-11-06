// What a failed inline image says (#64). The server answers 403 for a path it
// refuses (outside the asset root, or not an image type) and 404 for a file that
// isn't there; an <img> error can't see the status, so the widget asks once.

/** The chip text for a failed image, given the asset route's HTTP status and,
 *  for a 403, its `Blocked: <reason>` body (outside the root, or not an image). */
export function imageFailureText(url: string, status: number | null, body = ""): string {
  if (status !== 403) return `⚠ ${url} (missing)`;
  const reason = body.replace(/^Blocked:\s*/i, "").trim();
  return reason ? `⚠ ${url} (blocked: ${reason})` : `⚠ ${url} (blocked)`;
}

/** The asset route's answer for `src`, or null when it can't be read. */
export async function assetStatus(src: string): Promise<{ status: number; body: string } | null> {
  if (!src.startsWith("/api/asset?")) return null;
  try {
    const res = await fetch(src);
    return { status: res.status, body: res.status === 403 ? await res.text() : "" };
  } catch {
    return null;
  }
}
