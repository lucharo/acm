// ── Right-click context menu (fixed-position, closes on any outside event) ────

import { useEffect } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
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
  const width = 184;
  const x = Math.min(menu.x, window.innerWidth - width - 8);
  const y = Math.min(menu.y, window.innerHeight - (menu.items.length * 34 + 12));
  return (
    <div
      className="fixed z-50 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1 shadow-lg"
      style={{ left: x, top: y, width }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
    >
      {menu.items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          onClick={() => {
            it.onClick();
            onClose();
          }}
          className={`flex w-full items-center rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--line)] ${
            it.danger ? "text-[var(--crit-del)]" : "text-[var(--ink)]"
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
