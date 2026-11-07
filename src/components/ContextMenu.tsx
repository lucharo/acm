// ── Right-click context menu (fixed-position, closes on any outside event) ────

import { useEffect } from "react";

export interface MenuItem {
  /** Action label. Omitted for separators. */
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  /** Render as a divider rule rather than a row (label/onClick ignored). */
  separator?: boolean;
  /** Render as a non-interactive caption (e.g. "Suggestions") — uses `label`. */
  header?: boolean;
}
export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export default function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", onClose);
    window.addEventListener("contextmenu", onClose);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("click", onClose);
      window.removeEventListener("contextmenu", onClose);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  const width = 200;
  const x = Math.min(menu.x, window.innerWidth - width - 8);
  // Approximate height for the off-screen clamp: rows ~32px, separators/headers
  // are shorter but counting them as a row keeps the menu comfortably on-screen.
  const y = Math.min(menu.y, window.innerHeight - (menu.items.length * 32 + 12));
  return (
    <div
      className="fixed z-50 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1 shadow-lg"
      style={{ left: x, top: y, width }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
    >
      {menu.items.map((it, i) => {
        if (it.separator) {
          return <div key={i} className="my-1 border-t border-[var(--line)]" />;
        }
        if (it.header) {
          return (
            <div
              key={i}
              className="px-2.5 pb-0.5 pt-1 text-[10px] font-medium text-[var(--faint)]"
            >
              {it.label}
            </div>
          );
        }
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            onClick={() => {
              it.onClick?.();
              onClose();
            }}
            className={`flex w-full items-center truncate rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--line)] ${
              it.danger ? "text-[var(--crit-del)]" : "text-[var(--ink)]"
            }`}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
