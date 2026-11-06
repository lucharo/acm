// How ACM opens a URL in the user's browser (`acm edit`, `bun run dev`).
// ACM_NO_OPEN=1 skips it; a set $BROWSER is the opener (so BROWSER=/usr/bin/true,
// the usual "agents must not pop tabs" setting, opens nothing); otherwise the
// platform's opener. The URL is always printed, so skipping is never fatal.

type Env = Record<string, string | undefined>;

/** The argv that opens `url`, or null when opening is switched off. */
export function browserOpenCommand(url: string, env: Env = process.env, platform = process.platform): string[] | null {
  const noOpen = env.ACM_NO_OPEN?.trim();
  if (noOpen && noOpen !== "0") return null;
  const browser = env.BROWSER?.trim();
  if (browser) return [browser, url];
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

export function openBrowser(url: string): void {
  const command = browserOpenCommand(url);
  if (!command) return;
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // A missing opener is non-fatal: the URL is printed.
  }
}
