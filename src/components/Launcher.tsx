import { useState } from "react";
import type { FormEvent } from "react";
import type { AcmSession } from "../client/session";

type LauncherSession = Extract<AcmSession, { mode: "launcher" }>;

async function requestOpen(path: string, create: boolean): Promise<{ url: string }> {
  const response = await fetch("/api/launcher/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, create }),
  });
  const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!response.ok || !body?.url) throw new Error(body?.error ?? "ACM could not open that document.");
  return { url: body.url };
}

export default function Launcher({ session }: { session: LauncherSession }) {
  const [newPath, setNewPath] = useState("");
  const [openPath, setOpenPath] = useState("");
  const [opening, setOpening] = useState<{ path: string; create: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (path: string, create: boolean) => {
    const trimmed = path.trim();
    if (!trimmed || opening) return;
    setOpening({ path: trimmed, create });
    setError(null);
    try {
      const result = await requestOpen(trimmed, create);
      window.location.assign(result.url);
    } catch (cause) {
      setOpening(null);
      setError((cause as Error).message);
    }
  };
  const submit = (create: boolean, path: string) => (event: FormEvent) => {
    event.preventDefault();
    void open(path, create);
  };

  return (
    <main className="min-h-full overflow-y-auto bg-[var(--desk)] px-5 py-10 text-[var(--ink)] sm:px-8 sm:py-16">
      <div className="mx-auto w-full max-w-4xl">
        <header className="mb-9 flex items-center gap-3">
          <img src="/logo.png" alt="" className="h-9 w-9 rounded-lg" />
          <div>
            <div className="text-sm font-semibold tracking-tight">ACM</div>
            <div className="text-xs text-[var(--muted)]">Agent CriticMarkup</div>
          </div>
        </header>

        <div className="mb-9 max-w-2xl">
          <h1 className="text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">Open a document</h1>
          <p className="mt-3 text-base leading-relaxed text-[var(--muted)]">
            One Markdown file per window. Nothing is created until you choose a name.
          </p>
        </div>

        {error ? (
          <div role="alert" className="mb-5 rounded-xl border border-[var(--crit-del)] bg-[var(--panel)] px-4 py-3 text-sm text-[var(--crit-del)]">
            {error}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <form onSubmit={submit(true, newPath)} className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 shadow-sm">
            <h2 className="text-lg font-semibold">New document</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">Name a Markdown file before ACM creates it.</p>
            <label className="mt-5 block text-xs font-medium text-[var(--faint)]" htmlFor="new-document-path">
              Name or path
            </label>
            <input
              id="new-document-path"
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              placeholder="notes.md"
              autoComplete="off"
              className="mt-2 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-3 py-2.5 font-mono text-base outline-none focus:border-[var(--accent)] sm:text-sm"
            />
            <button
              type="submit"
              disabled={!newPath.trim() || opening !== null}
              className="mt-4 min-h-11 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--panel)] disabled:cursor-not-allowed disabled:bg-transparent disabled:text-[var(--faint)] disabled:opacity-100 disabled:ring-1 disabled:ring-inset disabled:ring-[var(--line-strong)]"
            >
              {opening?.create && opening.path === newPath.trim() ? "Creating…" : "Create and open"}
            </button>
          </form>

          <form onSubmit={submit(false, openPath)} className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Open document</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">Use an absolute path or one relative to the launch folder.</p>
            <label className="mt-5 block text-xs font-medium text-[var(--faint)]" htmlFor="open-document-path">
              Existing path
            </label>
            <input
              id="open-document-path"
              value={openPath}
              onChange={(event) => setOpenPath(event.target.value)}
              placeholder="drafts/essay.md"
              autoComplete="off"
              className="mt-2 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-3 py-2.5 font-mono text-base outline-none focus:border-[var(--accent)] sm:text-sm"
            />
            <button
              type="submit"
              disabled={!openPath.trim() || opening !== null}
              className="mt-4 min-h-11 rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            >
              {opening && !opening.create && opening.path === openPath.trim() ? "Opening…" : "Open"}
            </button>
          </form>
        </div>

        <section className="mt-8" aria-labelledby="recent-documents-heading">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="recent-documents-heading" className="text-lg font-semibold">Recent documents</h2>
              <p className="text-sm text-[var(--muted)]">Launch folder: <code className="break-all font-mono text-xs text-[var(--ink)]">{session.cwd}</code></p>
            </div>
          </div>
          {session.recent.length ? (
            <div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] shadow-sm">
              {session.recent.map((document) => (
                <button
                  key={document.path}
                  type="button"
                  disabled={opening !== null}
                  onClick={() => void open(document.path, false)}
                  className="flex w-full items-center justify-between gap-5 border-b border-[var(--line)] px-5 py-4 text-left last:border-b-0 hover:bg-[var(--line)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{document.name}</span>
                    <span className="mt-1 block truncate font-mono text-xs text-[var(--muted)]">{document.path}</span>
                  </span>
                  <span className="shrink-0 text-sm text-[var(--accent)]">
                    {opening && !opening.create && opening.path === document.path ? "Opening…" : "Open"}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-[var(--line-strong)] px-5 py-8 text-sm text-[var(--muted)]">
              Documents you open with ACM will appear here.
            </div>
          )}
        </section>

        <p className="mt-8 text-xs text-[var(--faint)]">Editor settings are global and apply to every ACM document.</p>
      </div>
    </main>
  );
}
