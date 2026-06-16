// ── Keyboard shortcuts cheat sheet ────────────────────────────────────────────
// A read-only reference modal (think Google Docs' ⌘/ sheet). Purely
// presentational: it renders the grouped list from lib/shortcuts. Opened from the
// ⌘K palette and the settings menu. Esc or a backdrop click closes it.

import { useEffect } from "react";
import { shortcutGroups } from "../lib/shortcuts";

export default function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const groups = shortcutGroups();

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[40rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-[var(--line-strong)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
          <span className="text-[14px] font-semibold text-[var(--ink)]">Keyboard shortcuts</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[12px] text-[var(--muted)] hover:bg-[var(--line)]"
          >
            Esc
          </button>
        </div>
        <div className="grid max-h-[64vh] grid-cols-1 gap-x-8 gap-y-5 overflow-y-auto p-4 sm:grid-cols-2">
          {groups.map((group) => (
            <section key={group.title}>
              <h3 className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--faint)]">
                {group.title}
              </h3>
              {group.note ? (
                <p className="mb-1.5 text-[11px] italic leading-snug text-[var(--muted)]">{group.note}</p>
              ) : null}
              <ul className="flex flex-col gap-1">
                {group.items.map((s) => (
                  <li key={s.label} className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] text-[var(--ink)]">{s.label}</span>
                    <kbd className="shrink-0 whitespace-nowrap rounded border border-[var(--line-strong)] bg-[var(--bg)] px-1.5 py-0.5 text-[11px] tabular-nums text-[var(--muted)]">
                      {s.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
