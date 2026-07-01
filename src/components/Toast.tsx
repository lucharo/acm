// Bottom-right toast stack — transient feedback for actions with an off-screen
// side effect (an image drop writing a file to disk: "Saved assets/…"). Purely
// presentational; App owns the queue and the auto-dismiss timer.

import type { ToastKind } from "../lib/types";

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

export default function ToastStack({ toasts }: { toasts: ToastItem[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={[
            "max-w-sm rounded-lg border px-3 py-2 text-[13px] leading-snug shadow-lg",
            t.kind === "error"
              ? "border-[var(--crit-del)] bg-[var(--panel)] text-[var(--crit-del)]"
              : "border-[var(--line)] bg-[var(--panel)] text-[var(--ink)]",
          ].join(" ")}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
