export interface PrintShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Command-P on macOS, Ctrl-P elsewhere. Modified variants remain available to
 * the browser/OS instead of being accidentally captured by ACM. */
export function isPrintShortcut(event: PrintShortcutEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "p"
  );
}
