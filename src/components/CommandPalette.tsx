// ── Command palette (⌘K) ───────────────────────────────────────────────────────
// A minimal action launcher: type to filter, ↑/↓ to move, ↵ to run, Esc closes.
// Actions are provided by the Workspace (which owns the editor/settings); the
// palette stays purely presentational — no document or settings knowledge here.

import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteAction {
  id: string;
  label: string;
  /** Small muted annotation on the right (current state, shortcut, …). */
  hint?: string;
  /** Disabled actions are hidden — the list shows only what can run right now. */
  disabled?: boolean;
  run: () => void;
}

export default function CommandPalette({
  actions,
  onClose,
}: {
  actions: PaletteAction[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = actions.filter((a) => !a.disabled);
    return q ? pool.filter((a) => a.label.toLowerCase().includes(q)) : pool;
  }, [actions, query]);

  // Clamp the selection when filtering shrinks the list.
  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runSelected = () => {
    const a = visible[sel];
    if (!a) return;
    onClose(); // close FIRST so actions that move focus/scroll aren't fighting the overlay
    a.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[18vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[34rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-[var(--line-strong)] bg-[var(--panel)] shadow-2xl">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, visible.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runSelected();
            }
          }}
          placeholder="Type a command…"
          className="w-full border-b border-[var(--line)] bg-transparent px-4 py-3 text-[14px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
        />
        <ul className="max-h-[40vh] overflow-y-auto py-1">
          {visible.length === 0 ? (
            <li className="px-4 py-3 text-[13px] text-[var(--muted)]">No matching command</li>
          ) : (
            visible.map((a, i) => (
              <li key={a.id}>
                <button
                  type="button"
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => {
                    // mousedown (not click) so the action fires before the input blurs.
                    e.preventDefault();
                    setSel(i);
                    onClose();
                    a.run();
                  }}
                  className={`flex w-full items-center justify-between px-4 py-2 text-left text-[13px] ${
                    i === sel ? "bg-[var(--line)] text-[var(--ink)]" : "text-[var(--ink)]"
                  }`}
                >
                  <span>{a.label}</span>
                  {a.hint ? <span className="text-[11px] text-[var(--faint)]">{a.hint}</span> : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
