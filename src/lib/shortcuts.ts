// ── Keyboard-shortcut reference (single source of truth) ──────────────────────
// Every shortcut the UI advertises lives here, grouped for the cheat sheet
// (ShortcutsOverlay) and reused for the ⌘K palette hint. Glyphs come from
// lib/platform so ⌘/⌥ vs Ctrl+/Alt+ is decided in one place.
//
// Movement keys (line/word/document) are CodeMirror's platform defaults — they
// differ between macOS and Windows/Linux, so that group is only listed on macOS
// where the ⌘/⌥ labels are accurate. The app-defined shortcuts above are
// MOD-based and correct on every platform.

import { ALT, MOD, SHIFT, isMac } from "./platform";

export interface Shortcut {
  /** Already-glyphed chord, e.g. "⌘B" or "⌘←  ⌘→" for a pair. */
  keys: string;
  label: string;
}

export interface ShortcutGroup {
  title: string;
  /** Optional clarifier shown under the group title. */
  note?: string;
  items: Shortcut[];
}

export function selectionAuthoringShortcut(event: {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): "comment" | "suggestion" | null {
  if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey) return null;
  if (event.code === "KeyM") return "comment";
  if (event.code === "KeyS") return "suggestion";
  return null;
}

export function shortcutGroups(): ShortcutGroup[] {
  const groups: ShortcutGroup[] = [
    {
      title: "Formatting",
      items: [
        { keys: `${MOD}B`, label: "Bold" },
        { keys: `${MOD}I`, label: "Italic" },
        { keys: `${MOD}U`, label: "Underline" },
        { keys: "/table ↵", label: "Insert table" },
      ],
    },
    {
      title: "Document",
      items: [
        { keys: `${MOD}K`, label: "Command palette" },
        { keys: `${MOD},`, label: "Settings" },
        { keys: `${MOD}/`, label: "Show this cheat sheet" },
        { keys: `${MOD}S`, label: "Save now" },
        { keys: `${MOD}P`, label: "Print / save as PDF" },
        { keys: `${MOD}A`, label: "Select all" },
        { keys: `${MOD}Z`, label: "Undo" },
        { keys: `${MOD}${SHIFT}Z`, label: "Redo" },
      ],
    },
    {
      title: "Comments",
      items: [
        { keys: `${MOD}${ALT}M`, label: "Comment on selected text" },
        { keys: `${MOD}${ALT}S`, label: "Suggest replacement for selected text" },
        { keys: `${MOD}↵`, label: "Post comment on the selection" },
        { keys: `${MOD}${SHIFT}↵`, label: "Post comment & mark it seen" },
        { keys: `${SHIFT}↵`, label: "New line inside a comment" },
      ],
    },
    {
      title: "Review changes",
      note: "When the cursor is outside the editor",
      items: [
        { keys: "↓ / ↑", label: "Next / previous card (with a card selected)" },
        { keys: `${ALT}↓ / J`, label: "Next comment or change" },
        { keys: `${ALT}↑ / K`, label: "Previous comment or change" },
        { keys: `${ALT}Y`, label: "Accept the suggestion" },
        { keys: `${ALT}N`, label: "Reject the suggestion" },
      ],
    },
  ];

  if (isMac) {
    // Insert the movement group right after Formatting (mac-only — see header).
    groups.splice(1, 0, {
      title: "Move around",
      items: [
        { keys: "⌘←  ⌘→", label: "Start / end of line" },
        { keys: "⌘↑  ⌘↓", label: "Start / end of document" },
        { keys: "⌥←  ⌥→", label: "Previous / next word" },
      ],
    });
  }

  return groups;
}
