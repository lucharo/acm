export interface LauncherRecentDocument {
  path: string;
  name: string;
  openedAt: string;
}

export type AcmSession =
  | { mode: "document"; path: string }
  | { mode: "launcher"; cwd: string; recent: LauncherRecentDocument[] };

function isLauncherRecentDocument(value: unknown): value is LauncherRecentDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    typeof entry.name === "string" &&
    typeof entry.openedAt === "string"
  );
}

export function parseAcmSession(value: unknown): AcmSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ACM server returned an incompatible session");
  }
  const session = value as Record<string, unknown>;
  if (session.mode === "document" && typeof session.path === "string") {
    return { mode: "document", path: session.path };
  }
  if (
    session.mode === "launcher" &&
    typeof session.cwd === "string" &&
    Array.isArray(session.recent) &&
    session.recent.every(isLauncherRecentDocument)
  ) {
    return {
      mode: "launcher",
      cwd: session.cwd,
      recent: session.recent as LauncherRecentDocument[],
    };
  }
  throw new Error("ACM server returned an incompatible session");
}

export async function fetchAcmSession(): Promise<AcmSession> {
  const response = await fetch("/api/session");
  if (!response.ok) throw new Error(`ACM session unavailable (${response.status})`);
  return parseAcmSession(await response.json());
}
