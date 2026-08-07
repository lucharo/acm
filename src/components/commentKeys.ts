import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** Shared multi-line comment keyboard model:
 * Enter / Mod-Enter submits, Mod-Shift-Enter submits and marks done,
 * Shift-Enter inserts a line break, and Escape cancels. */
export function handleCommentKey(
  event: ReactKeyboardEvent,
  onSubmit: () => void,
  onSubmitDone: () => void,
  onCancel: () => void,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    onCancel();
    return;
  }
  if (event.key !== "Enter") return;
  const mod = event.metaKey || event.ctrlKey;
  if (event.shiftKey && !mod) return;
  event.preventDefault();
  (event.shiftKey && mod ? onSubmitDone : onSubmit)();
}
