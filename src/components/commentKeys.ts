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

/** Closing a reply box throws its draft away. An empty draft closes at once; a
 *  draft with text asks first, so a stray Escape or Cancel never eats a reply. */
export function mayDiscardDraft(draft: string, ask: (message: string) => boolean): boolean {
  return draft.trim() === "" || ask("Discard this reply?");
}

/** While the comment composer is open, its keys still work after focus has gone
 *  back to the document (a click into the text to check something): Mod-Enter
 *  posts, Mod-Shift-Enter posts and marks done, Escape cancels. Plain Enter and
 *  Shift-Enter stay the document's, and a key typed in a text field (the composer
 *  box itself, a reply box, a setting) is left to that field. */
export function composerKeyOutsideBox(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: EventTarget | { tagName?: string } | null;
}): "post" | "post-done" | "cancel" | null {
  const tag = (event.target as { tagName?: string } | null)?.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return null;
  if (event.key === "Escape") return event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ? null : "cancel";
  if (event.key !== "Enter" || event.altKey || !(event.metaKey || event.ctrlKey)) return null;
  return event.shiftKey ? "post-done" : "post";
}
