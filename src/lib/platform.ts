// ── Platform glyphs for keyboard hints ────────────────────────────────────────
// One place to resolve the modifier key labels we print in tooltips, the command
// palette, and the shortcuts cheat sheet, so ⌘ vs Ctrl is decided once.

export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Primary modifier: ⌘ on macOS, "Ctrl+" elsewhere. */
export const MOD = isMac ? "⌘" : "Ctrl+";
/** Alt/Option: ⌥ on macOS, "Alt+" elsewhere. */
export const ALT = isMac ? "⌥" : "Alt+";
/** Shift glyph (same everywhere, kept here so callers don't sprinkle the glyph). */
export const SHIFT = "⇧";
