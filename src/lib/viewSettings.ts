// ── View settings (shared by App, Header, and the settings hooks) ─────────────
// The persisted editor preferences. localStorage is the instant cache; the
// server file (~/.config/acm/settings.json) is the cross-instance truth — see
// the sync wiring in App.

export type Theme = "light" | "dark" | "system";
export type Font = "serif" | "sans" | "mono";
export type SpellVariant = "uk" | "us"; // British vs American spelling dictionary
export type CommentRailMode = "auto" | "show" | "hide";
export type PrintStyle = "simple" | "tufte";
export interface ViewSettings {
  theme: Theme;
  font: Font;
  page: boolean; // Page view: A4 sheets on a desk, page-break markers and the page tally
  lineNumbers: boolean;
  bionic: boolean; // bionic-reading: bold the lead of each word (rendered only)
  progressBar: boolean; // thin reading-progress bar under the header (fills as you scroll)
  richPreview: boolean; // rendered Markdown/review view; false exposes canonical source
  printStyle: PrintStyle; // browser print/PDF presentation; never changes document bytes
  printAlternateSides: boolean; // Tufte reference ribs follow odd/right, even/left book-page parity
  showSeen: boolean; // reveal comments marked "seen" (off = they're hidden, zero-inbox)
  commentRail: CommentRailMode; // auto by default; can be pinned open or hidden
  applyAndResolve: boolean; // make Apply also close the complete suggestion discussion
  spellcheck: boolean; // wiggly-underline misspelled words (editor/spellcheck.ts)
  spellVariant: SpellVariant; // which dictionary spell check runs against
  author: string; // name stamped on comments YOU add through the UI
}
export const FONT_STACKS: Record<Font, string> = {
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  sans: 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};
export const FONT_LABELS: Record<Font, string> = { serif: "Serif", sans: "Sans", mono: "Mono" };

export const DEFAULT_SETTINGS: ViewSettings = {
  theme: "system", // fresh installs follow the OS; stored choices override
  font: "serif",
  page: true,
  lineNumbers: false,
  bionic: false,
  progressBar: true, // on by default — a quiet, familiar reading affordance
  richPreview: true,
  printStyle: "simple",
  printAlternateSides: true,
  showSeen: false,
  commentRail: "auto",
  applyAndResolve: false,
  spellcheck: true, // on by default — the Google-Docs expectation for a prose editor
  spellVariant: "uk", // British English by default
  author: "You",
};
/** Keys a stored settings object may still carry from an older build. The
 * server file merges patches, so it never forgets them; reads drop them.
 * `pageBreaks` became part of `page` (#40): the stored sheet choice wins. */
const RETIRED_KEYS = ["pageBreaks"];

export function withoutRetiredSettings<T extends object>(stored: T): T {
  const clean = { ...stored } as Record<string, unknown>;
  for (const key of RETIRED_KEYS) delete clean[key];
  return clean as T;
}

export function loadSettings(): ViewSettings {
  try {
    const stored = JSON.parse(localStorage.getItem("acm-settings") ?? "{}");
    return { ...DEFAULT_SETTINGS, ...withoutRetiredSettings(stored) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
