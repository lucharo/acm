// ── View settings (shared by App, Header, and the settings hooks) ─────────────
// The persisted editor preferences. localStorage is the instant cache; the
// server file (~/.config/acm/settings.json) is the cross-instance truth — see
// the sync wiring in App.

export type Theme = "light" | "dark" | "system";
export type Font = "serif" | "sans" | "mono";
export interface ViewSettings {
  theme: Theme;
  font: Font;
  page: boolean; // A4-style page view (document as a sheet on a desk)
  lineNumbers: boolean;
  bionic: boolean; // bionic-reading: bold the lead of each word (rendered only)
  pageBreaks: boolean; // A4 page-break markers + page tally (a sense of print length)
  showSeen: boolean; // reveal comments marked "seen" (off = they're hidden, zero-inbox)
  spellcheck: boolean; // wiggly-underline misspelled words (editor/spellcheck.ts)
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
  pageBreaks: false,
  showSeen: false,
  spellcheck: true, // on by default — the Google-Docs expectation for a prose editor
  author: "You",
};
export function loadSettings(): ViewSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("acm-settings") ?? "{}") };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
