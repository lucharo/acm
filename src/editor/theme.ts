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
      // Bottom margin = extra scroll reach when comment cards stack below the
      // last line (set by App from the sidebar's overflow report). A margin —
      // not min-height — so the page sheet never stretches past the prose; the
      // reach reads as desk/background, and scroll range still covers the cards.
      margin: "0 auto var(--acm-scroll-reach, 0px)",
      padding: "2.5rem 3rem 6rem 3rem",
      caretColor: "var(--ink)",
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
    // Footnotes: `[^id]` references and `[^id]:` labels are clickable (jump to the
    // note / back to the reference — see footnotes.ts). Cursor affordance only; the
    // common reference also carries .cm-md-link colour from lezer.
    ".cm-footnote-ref, .cm-footnote-def-label": {
      cursor: "pointer",
    },
    ".cm-footnote-ref:hover, .cm-footnote-def-label:hover": {
      textDecoration: "underline",
      textUnderlineOffset: "2px",
    },
    // Brief highlight on the target a footnote jump lands on.
    ".cm-footnote-flash": {
      backgroundColor: "var(--crit-hl-bg-strong)",
      borderRadius: "3px",
    },
    // Bionic-reading: emboldened word-leads (toggled in settings).
    ".cm-bionic": {
      fontWeight: "700",
    },
    // Spell check: a red wavy underline under a misspelled word (editor/spellcheck.ts).
    // Decoration-only, so it layers cleanly over any prose — including green
    // insertions or yellow highlights. skip-ink off keeps the wave continuous.
    ".cm-spell-error": {
      textDecoration: "underline",
      textDecorationStyle: "wavy",
      textDecorationColor: "var(--spell)",
      textDecorationSkipInk: "none",
      textUnderlineOffset: "2px",
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
    // …but an ACTIVE busy span keeps its bottom accent: equal-specificity --active
    // and --busy both set boxShadow, so without this the later --busy ring would win
    // and the focused span would lose its underline. A compound (two-class) rule wins
    // on specificity regardless of source order.
    ".cm-crit-hl--active.cm-crit-hl--busy": {
      boxShadow: "inset 0 -2px 0 var(--crit-comment)",
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
    // "or" separator before a COMPETING suggestion on the same span, so two
    // proposals never read as one concatenated wording.
    ".cm-crit-suggest-or": {
      color: "var(--muted)",
      fontStyle: "italic",
      fontSize: "0.8em",
      margin: "0 0.35em 0 0.15em",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
    },
    // Suggestion-group membership chip (⛓N) — informational; group-wide controls
    // live on the sidebar card.
    ".cm-crit-suggest-group": {
      marginLeft: "4px",
      color: "var(--muted)",
      fontSize: "0.72em",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      verticalAlign: "baseline",
    },
    // Empty-replacement suggestion = "delete this span" — a muted marker, not green.
    ".cm-crit-suggest-del": {
      color: "var(--muted)",
      fontStyle: "italic",
      fontSize: "0.85em",
      padding: "0.02em 0.06em",
    },
    // The "has discussion" badge — a 💬 + message count, so accepting inline never
    // silently bypasses an unread parent/sibling comment. Overrides the dot visuals
    // of .cm-crit-comment-anchor (kept only for click routing) into a small text pill.
    ".cm-crit-suggest-thread": {
      width: "auto",
      height: "auto",
      marginLeft: "5px",
      padding: "0 0.35em",
      borderRadius: "999px",
      backgroundColor: "transparent",
      color: "var(--crit-comment)",
      opacity: "0.75",
      fontSize: "0.72em",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      verticalAlign: "baseline",
      transform: "none",
    },

    // ── Phone-width reading ─────────────────────────────────────────────────────
    // On a ~390px screen the desktop 3rem side gutters trap prose in a thin column.
    // Pull the gutters in (and the top in a touch) so text uses the width. Lives
    // inside the theme — style-mod still scopes these to the editor's generated
    // class, so they tie specificity with the base rule and win by source order
    // (no fight with index.css). Comes LAST in the spec so it overrides .cm-content.
    "@media (max-width: 640px)": {
      "&": { fontSize: "16px" },
      ".cm-content": {
        padding: "1.25rem 1.1rem 5rem 1.1rem",
      },
      // Fatten the touch targets a phone needs: the inline accept/reject pills
      // (desktop 1.15em ≈ 19px is a hard tap) and the comment anchor dot (6px).
      // Inline elements can't be 44px without breaking the text line, so this is a
      // pragmatic bump, not the full HIG size — the whole highlighted span is also
      // tappable (focusCommentAtPoint), so comments have a large target regardless.
      ".cm-crit-accept, .cm-crit-reject": {
        width: "1.65em",
        height: "1.65em",
        fontSize: "0.85em",
      },
      ".cm-crit-comment-anchor": {
        width: "9px",
        height: "9px",
        marginLeft: "3px",
      },
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
    margin: "0 auto var(--acm-scroll-reach, 0px)", // same reach var as the base theme
    padding: "4rem 4.5rem 6rem",
    backgroundColor: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: "2px",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.07), 0 14px 40px rgba(0, 0, 0, 0.09)",
    minHeight: "70vh", // a fresh/short doc still reads as a sheet
  },

  // ── Phone-width reading ───────────────────────────────────────────────────────
  // The A4-sheet metaphor doesn't fit a phone: a bordered sheet centred on a desk
  // just leaves a cramped column with slivers of desk either side. Drop the desk
  // margin to a sliver and run the sheet edge-to-edge — no side border/radius/shadow
  // (only the hairline top/bottom border survives, a faint "page" cue). The inner
  // prose padding is governed by acmTheme's own phone rule (the base theme wins
  // shared props like padding over this one), so we DON'T re-declare it here — we
  // only strip the chrome that's unique to the sheet.
  "@media (max-width: 640px)": {
    ".cm-scroller": { padding: "0.5rem 0 4rem" },
    ".cm-content": {
      borderLeft: "none",
      borderRight: "none",
      borderRadius: "0",
      boxShadow: "none",
    },
  },
});
