// ── ACM editor theme ──────────────────────────────────────────────────────────
// A minimalist, high-density, typographic look. Prose in a comfortable serif,
// generous line-height, a centred ~680px content column with right padding that
// leaves room for the comment sidebar. All CriticMarkup colours come from the
// CSS variables already defined in src/index.css (single palette, no drift).
//
// No line numbers, no active-line gutter, line wrapping on. Hidden markdown
// markers (handled by markdownPreview.ts) and hidden comment markup
// (criticMarkupView.ts) leave no visual gap — these `cm-crit-*` rules only style
// what stays visible.

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export const acmTheme: Extension = EditorView.theme(
  {
    "&": {
      color: "var(--ink)",
      backgroundColor: "transparent",
      fontSize: "17px",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      fontFamily: "var(--editor-font)",
      lineHeight: "1.7",
      overflow: "auto",
    },
    // Centred prose column. The comment sidebar is its own panel, so the editor
    // only needs a modest right gutter for the comment-anchor glyphs + connectors.
    ".cm-content": {
      maxWidth: "680px",
      margin: "0 auto",
      padding: "2.5rem 3rem 6rem 3rem",
      caretColor: "var(--ink)",
      // App sets --acm-content-min so the doc can scroll far enough to reveal
      // comment cards that stack below the last line of text.
      minHeight: "var(--acm-content-min, auto)",
    },
    ".cm-line": {
      padding: "0",
    },
    // Line-number gutter (optional, toggled in settings) — subtle, muted, tabular;
    // NOT the editor's serif. Transparent, no border, so it reads as a quiet margin.
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--faint)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: "0.7em",
      padding: "0 0.6em 0 1em",
      color: "var(--faint)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--muted)",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--ink)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "var(--cm-selection)",
    },
    "::selection": {
      backgroundColor: "var(--cm-selection)",
    },

    // ── Markdown live-preview classes (styled by markdownPreview.ts marks) ──────
    ".cm-md-h1": {
      fontSize: "1.85em",
      fontWeight: "700",
      lineHeight: "1.25",
    },
    ".cm-md-h2": {
      fontSize: "1.45em",
      fontWeight: "700",
      lineHeight: "1.3",
    },
    ".cm-md-h3": {
      fontSize: "1.2em",
      fontWeight: "650",
      lineHeight: "1.35",
    },
    ".cm-md-h4, .cm-md-h5, .cm-md-h6": {
      fontSize: "1.05em",
      fontWeight: "650",
    },
    ".cm-md-strong": { fontWeight: "700" },
    ".cm-md-em": { fontStyle: "italic" },
    ".cm-md-code": {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: "0.88em",
      background: "var(--line)",
      borderRadius: "4px",
      padding: "0.08em 0.32em",
    },
    ".cm-md-quote": {
      color: "var(--muted)",
      fontStyle: "italic",
    },
    // A blockquote line gets a left rule. Applied per line via line decoration.
    ".cm-md-quote-line": {
      borderLeft: "3px solid var(--line-strong)",
      paddingLeft: "1rem",
    },
    ".cm-md-list": {
      color: "var(--muted)",
    },
    // Rendered list bullet (replaces a `-`/`*`/`+` marker). A touch of right space so
    // "• item" reads as a list, slightly muted so the prose stays the focus.
    ".cm-md-bullet": {
      color: "var(--muted)",
      paddingRight: "0.4em",
    },
    ".cm-md-link": {
      color: "var(--author-0)",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
    },
    // Bionic-reading: emboldened word-leads (toggled in settings).
    ".cm-bionic": {
      fontWeight: "700",
    },
    // Substitution arrow rendered in place of `~>`.
    ".cm-md-sub-arrow": {
      color: "var(--muted)",
      padding: "0 0.18em",
      fontWeight: "600",
    },

    // ── CriticMarkup mark classes ───────────────────────────────────────────────
    ".cm-crit-ins": {
      color: "var(--crit-ins)",
      backgroundColor: "var(--crit-ins-bg)",
      borderRadius: "3px",
      padding: "0.02em 0.06em",
    },
    ".cm-crit-del": {
      color: "var(--crit-del)",
      backgroundColor: "var(--crit-del-bg)",
      textDecoration: "line-through",
      borderRadius: "3px",
      padding: "0.02em 0.06em",
    },
    ".cm-crit-sub-old": {
      color: "var(--crit-del)",
      backgroundColor: "var(--crit-del-bg)",
      textDecoration: "line-through",
      borderRadius: "3px 0 0 3px",
      padding: "0.02em 0.06em",
    },
    ".cm-crit-sub-new": {
      color: "var(--crit-ins)",
      backgroundColor: "var(--crit-ins-bg)",
      borderRadius: "0 3px 3px 0",
      padding: "0.02em 0.06em",
    },
    ".cm-crit-hl": {
      backgroundColor: "var(--crit-hl-bg)",
      color: "var(--crit-hl-ink)",
      borderRadius: "3px",
      padding: "0.02em 0.06em",
    },
    // Active comment's anchor — a subtle bottom accent (not a full ring, which read
    // as too heavy), so the focused span stands out just a touch.
    ".cm-crit-hl--active": {
      boxShadow: "inset 0 -2px 0 var(--crit-comment)",
    },
    // Busier span — carries a multi-comment thread. A lightness step down on the
    // same hue (colourblind-safe density cue), like GDocs darkening regions with
    // more comments. Sits under --active/--seen, which override the feel as needed.
    ".cm-crit-hl--busy": {
      backgroundColor: "var(--crit-hl-bg-strong)",
      boxShadow: "inset 0 0 0 1px var(--crit-hl-ink)",
    },
    // Seen comment's anchor — colourblind-safe: muted neutral fill + a dotted
    // underline (lightness + texture, NOT hue), so reviewed spans read as "done".
    ".cm-crit-hl--seen": {
      backgroundColor: "var(--line)",
      color: "var(--muted)",
      textDecoration: "underline dotted",
      textDecorationColor: "var(--faint)",
      textUnderlineOffset: "2px",
    },

    // ── Inline accept / reject pill buttons ─────────────────────────────────────
    ".cm-crit-controls": {
      display: "inline-flex",
      gap: "2px",
      margin: "0 0.15em 0 0.3em",
      verticalAlign: "baseline",
      userSelect: "none",
    },
    ".cm-crit-accept, .cm-crit-reject": {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "1.15em",
      height: "1.15em",
      fontSize: "0.72em",
      lineHeight: "1",
      borderRadius: "999px",
      border: "1px solid var(--line-strong)",
      cursor: "pointer",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      transition: "background-color 80ms ease, color 80ms ease",
    },
    ".cm-crit-accept": {
      color: "var(--crit-ins)",
      backgroundColor: "var(--panel)",
    },
    ".cm-crit-accept:hover": {
      color: "var(--panel)",
      backgroundColor: "var(--crit-ins)",
      borderColor: "var(--crit-ins)",
    },
    ".cm-crit-reject": {
      color: "var(--crit-del)",
      backgroundColor: "var(--panel)",
    },
    ".cm-crit-reject:hover": {
      color: "var(--panel)",
      backgroundColor: "var(--crit-del)",
      borderColor: "var(--crit-del)",
    },

    // ── Comment anchor (replaces hidden comment markup) ─────────────────────────
    // A small, subtle dot rather than an emoji — stacked comments read as a tidy
    // row of dots instead of a crowd of 💬. The active thread's dots are emphasised
    // by criticMarkupView via the cm-crit-comment-anchor--active class.
    ".cm-crit-comment-anchor": {
      display: "inline-block",
      width: "6px",
      height: "6px",
      marginLeft: "2px",
      borderRadius: "50%",
      backgroundColor: "var(--crit-comment)",
      opacity: "0.45",
      verticalAlign: "super",
      cursor: "pointer",
      transition: "opacity 80ms ease, transform 80ms ease",
    },
    ".cm-crit-comment-anchor:hover": {
      opacity: "0.9",
      transform: "scale(1.25)",
    },
    ".cm-crit-comment-anchor--active": {
      opacity: "1",
      transform: "scale(1.25)",
    },

    // ── Inline SUGGEST: pair (renders like a native substitution) ───────────────
    // The struck "old" half reuses .cm-crit-sub-old (on the anchor highlight); this
    // widget supplies the green "new" half (.cm-crit-sub-new) + ✓/✗ + an optional
    // discussion dot. Keep it baseline-aligned so it sits in the text flow.
    ".cm-crit-suggest": {
      display: "inline",
    },
    // Empty-replacement suggestion = "delete this span" — a muted marker, not green.
    ".cm-crit-suggest-del": {
      color: "var(--muted)",
      fontStyle: "italic",
      fontSize: "0.85em",
      padding: "0.02em 0.06em",
    },
    // The "has discussion" dot — slightly offset from the controls so it reads as a
    // separate affordance (a real thread hangs underneath; don't hide it).
    ".cm-crit-suggest-thread": {
      marginLeft: "4px",
    },
  },
  { dark: false },
);

// Optional "page" view (toggled in settings): the document reads like an A4 sheet
// — a panel-coloured page with a border + shadow, centred on a darker "desk".
// Toggled via a Compartment in useCodeMirror so it layers cleanly over acmTheme
// (no CSS-specificity fight). documentPadding tracks the page padding, so the
// comment sidebar's anchoring adapts automatically.
export const pageTheme: Extension = EditorView.theme({
  ".cm-scroller": {
    backgroundColor: "var(--desk)",
    padding: "2.5rem 0 5rem",
  },
  ".cm-content": {
    maxWidth: "740px",
    margin: "0 auto",
    padding: "4rem 4.5rem 6rem",
    backgroundColor: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: "2px",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.07), 0 14px 40px rgba(0, 0, 0, 0.09)",
    minHeight: "var(--acm-content-min, 70vh)",
  },
});
