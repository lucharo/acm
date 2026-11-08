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
      fontSize: "16px",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      fontFamily: "var(--editor-font)",
      lineHeight: "1.68",
      overflow: "auto",
    },
    // Centred prose column. The comment sidebar is its own panel, so the editor
    // only needs a modest right gutter for the comment-anchor glyphs + connectors.
    ".cm-content": {
      maxWidth: "720px",
      // Bottom margin = extra scroll reach when comment cards stack below the
      // last line (set by App from the sidebar's overflow report). A margin —
      // not min-height — so the page sheet never stretches past the prose; the
      // reach reads as desk/background, and scroll range still covers the cards.
      margin: "0 auto var(--acm-scroll-reach, 0px)",
      padding: "3.5rem 2.5rem 6rem 2.5rem",
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
    // The browser's native selection belongs to whichever control has focus. When
    // the review composer takes focus, this mapped mark keeps its anchor visible.
    ".cm-composer-anchor": {
      backgroundColor: "var(--cm-selection)",
      borderRadius: "2px",
    },

    // ── Markdown live-preview classes (styled by markdownPreview.ts marks) ──────
    ".cm-md-h1": {
      fontSize: "1.9em",
      fontWeight: "700",
      letterSpacing: "-0.012em",
      lineHeight: "1.25",
    },
    ".cm-md-h2": {
      fontSize: "1.3em",
      fontWeight: "600",
      letterSpacing: "-0.012em",
      lineHeight: "1.3",
    },
    ".cm-md-h3": {
      fontSize: "1.1em",
      fontWeight: "600",
      letterSpacing: "-0.012em",
      lineHeight: "1.35",
    },
    ".cm-md-h4, .cm-md-h5, .cm-md-h6": {
      fontSize: "1.05em",
      fontWeight: "650",
    },
    ".cm-md-strong": { fontWeight: "700" },
    ".cm-md-em": { fontStyle: "italic" },
    // Quiet inline code: a faint tint, no box edge, so it reads as part of
    // the sentence rather than a grey block (#79).
    ".cm-md-code": {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: "0.86em",
      background: "color-mix(in srgb, var(--ink) 5%, transparent)",
      borderRadius: "3px",
      padding: "0.05em 0.22em",
    },
    ".cm-math-widget": {
      color: "inherit",
      cursor: "text",
    },
    // Block widgets carry their vertical spacing as PADDING, never margin:
    // CodeMirror measures a block's height with getBoundingClientRect, which
    // leaves margins out, so a margin desyncs the height map and the line-number
    // gutter drifts by it under every block (#70).
    ".cm-math-widget .katex-display": {
      margin: "0",
      padding: "0.55em 0",
      overflowX: "auto",
      overflowY: "hidden",
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
      fontWeight: "560", // lighter than bold, so long passages stay calm (#79)
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
    // Rendered inline image (replaces `![alt](url)` off the active line —
    // markdownPreview.ts ImageWidget). Constrained to the prose column and a
    // sane viewport share so a full-res screenshot doesn't swallow the page;
    // click places the cursor → the raw syntax reveals.
    ".cm-md-image img": {
      maxWidth: "100%",
      maxHeight: "60vh",
      display: "inline-block",
      verticalAlign: "text-bottom",
      borderRadius: "6px",
      cursor: "text",
    },
    // A reference whose file didn't load — show the path, don't vanish.
    ".cm-md-image-missing": {
      color: "var(--muted)",
      backgroundColor: "var(--line)",
      borderRadius: "4px",
      padding: "0.05em 0.4em",
      fontSize: "0.85em",
      fontFamily: "ui-monospace, monospace",
    },
    // Parsed GFM table (markdownPreview.ts TableWidget). The fixed layout and
    // anywhere wrapping keep wide content inside the prose column.
    ".cm-md-table-wrap": {
      boxSizing: "border-box",
      width: "100%",
      maxWidth: "100%",
      overflow: "hidden",
      cursor: "default",
      position: "relative",
    },
    ".cm-md-table": {
      width: "100%",
      maxWidth: "100%",
      tableLayout: "fixed",
      borderCollapse: "collapse",
      fontFamily: "var(--editor-font)",
      fontSize: "0.94em",
      lineHeight: "1.45",
    },
    ".cm-md-table th, .cm-md-table td": {
      border: "1px solid var(--line-strong)",
      padding: "0.38em 0.55em",
      verticalAlign: "top",
      overflowWrap: "break-word",
      wordBreak: "normal",
      cursor: "text",
      outline: "none",
      transition: "background-color 120ms ease, box-shadow 120ms ease",
      position: "relative",
    },
    "@media (hover: hover)": {
      ".cm-md-table th:hover, .cm-md-table td:hover": {
        boxShadow: "inset 0 0 0 1px var(--accent)",
      },
    },
    ".cm-md-table th": {
      backgroundColor: "var(--line)",
      fontWeight: "700",
      color: "var(--ink)",
    },
    ".cm-md-table td": {
      backgroundColor: "var(--panel)",
    },
    ".cm-md-table-cell-commented": {
      boxShadow: "inset 3px 0 0 var(--crit-comment)",
      backgroundColor: "var(--crit-hl-bg)",
    },
    ".cm-md-table-action": {
      appearance: "none",
      border: "0",
      borderRadius: "999px",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      cursor: "pointer",
    },
    ".cm-md-table-edit, .cm-md-table-comment-add": {
      position: "absolute",
      top: "2px",
      width: "1.3rem",
      height: "1.3rem",
      backgroundColor: "var(--panel)",
      boxShadow: "0 0 0 1px var(--line-strong)",
      opacity: "0",
      transition: "opacity 100ms ease",
    },
    ".cm-md-table-edit": {
      right: "1.55rem",
      color: "var(--muted)",
      fontSize: "0.78em",
    },
    ".cm-md-table-comment-marker": {
      marginLeft: "0.35em",
      backgroundColor: "transparent",
      padding: "0 0.12em",
      color: "var(--crit-comment)",
      fontSize: "0.72em",
      verticalAlign: "super",
    },
    ".cm-md-table-comment-add": {
      right: "2px",
      color: "var(--crit-comment)",
    },
    ".cm-md-table th:hover .cm-md-table-edit, .cm-md-table td:hover .cm-md-table-edit, .cm-md-table th:hover .cm-md-table-comment-add, .cm-md-table td:hover .cm-md-table-comment-add, .cm-md-table th:focus-within .cm-md-table-edit, .cm-md-table td:focus-within .cm-md-table-edit, .cm-md-table th:focus-within .cm-md-table-comment-add, .cm-md-table td:focus-within .cm-md-table-comment-add": {
      opacity: "1",
    },
    ".cm-md-table-action:focus-visible": {
      outline: "2px solid var(--accent)",
      outlineOffset: "2px",
      opacity: "1",
    },
    ".cm-md-table-cell-input": {
      boxSizing: "border-box",
      width: "100%",
      minWidth: "0",
      border: "0",
      borderRadius: "3px",
      outline: "2px solid var(--accent)",
      outlineOffset: "2px",
      backgroundColor: "var(--panel)",
      color: "var(--ink)",
      font: "inherit",
      lineHeight: "inherit",
      padding: "0",
    },
    ".cm-md-table a": {
      color: "var(--accent)",
      textDecoration: "underline",
      textUnderlineOffset: "0.12em",
    },
    ".cm-md-table code": {
      borderRadius: "3px",
      backgroundColor: "var(--line)",
      padding: "0.08em 0.25em",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "0.9em",
    },
    ".cm-md-html-block": {
      boxSizing: "border-box",
      width: "100%",
      maxWidth: "100%",
      padding: "0.35em 0", // padding, not margin (#70)
      color: "var(--ink)",
      fontFamily: "var(--editor-font)",
      fontSize: "0.94em",
      lineHeight: "1.5",
    },
    ".cm-md-code-block": {
      boxSizing: "border-box",
      width: "100%",
      maxWidth: "100%",
      padding: "0.55em 0", // padding, not margin (#70)
      color: "var(--ink)",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: "0.88em",
      lineHeight: "1.5",
    },
    ".cm-md-code-block pre": {
      boxSizing: "border-box",
      maxWidth: "100%",
      margin: "0",
      overflowX: "auto",
      border: "0",
      borderRadius: "6px",
      backgroundColor: "color-mix(in srgb, var(--ink) 4%, transparent)",
      padding: "0.7em 0.85em",
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
    },
    ".cm-md-code-block code": {
      font: "inherit",
    },
    ".cm-md-code-block code[data-language]::before": {
      content: "attr(data-language)",
      display: "block",
      marginBottom: "0.35em",
      color: "var(--faint)",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      fontSize: "0.78em",
      fontWeight: "500",
    },
    ".cm-rich-html-table": {
      width: "100%",
      maxWidth: "100%",
      tableLayout: "fixed",
      borderCollapse: "collapse",
    },
    ".cm-rich-html-table th, .cm-rich-html-table td": {
      border: "1px solid var(--line-strong)",
      padding: "0.5em 0.65em",
      verticalAlign: "top",
    },
    ".cm-rich-html-table ul, .cm-rich-html-table ol": {
      margin: "0",
      paddingLeft: "1.25em",
    },
    ".cm-rich-html-table li + li": {
      marginTop: "0.25em",
    },
    // Substitution arrow rendered in place of `~>`.
    ".cm-md-sub-arrow": {
      color: "var(--muted)",
      padding: "0 0.18em",
      fontWeight: "600",
    },

    // ── CriticMarkup mark classes ───────────────────────────────────────────────
    // An inline addition is green, underlined text: no box, so a one-line
    // addition (a sentence, a list item) sits in the flow of the text (#79).
    ".cm-crit-ins": {
      color: "var(--crit-ins)",
      textDecoration: "underline",
      textDecorationThickness: "2px",
      textUnderlineOffset: "3px",
    },
    // The widget's outer element holds the spacing as padding (#70); the
    // bordered card is the inner section.
    ".cm-crit-block": {
      padding: "0.55em 0",
    },
    ".cm-crit-block-ins": {
      boxSizing: "border-box",
      width: "100%",
      padding: "0.5em 0.7em 0.65em",
      border: "1px solid color-mix(in srgb, var(--crit-ins) 35%, var(--line))",
      borderLeft: "3px solid var(--crit-ins)",
      borderRadius: "7px",
      backgroundColor: "var(--crit-ins-bg)",
      color: "var(--ink)",
    },
    ".cm-crit-block-toolbar": {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "0.75em",
      marginBottom: "0.4em",
      fontFamily: "ui-sans-serif, -apple-system, sans-serif",
    },
    ".cm-crit-block-label": {
      color: "var(--crit-ins)",
      fontSize: "0.78em",
      fontWeight: "600",
    },
    ".cm-crit-block-actions": {
      display: "flex",
      alignItems: "center",
      gap: "0.3em",
    },
    ".cm-crit-block-action": {
      appearance: "none",
      border: "1px solid var(--line-strong)",
      borderRadius: "5px",
      backgroundColor: "var(--panel)",
      padding: "0.2em 0.48em",
      fontFamily: "inherit",
      fontSize: "0.72em",
      lineHeight: "1.3",
      cursor: "pointer",
    },
    ".cm-crit-block-action:focus-visible": {
      outline: "2px solid var(--accent)",
      outlineOffset: "2px",
    },
    ".cm-crit-block-accept": {
      color: "var(--crit-ins)",
    },
    ".cm-crit-block-reject": {
      color: "var(--crit-del)",
    },
    ".cm-crit-block-raw": {
      color: "var(--muted)",
    },
    ".cm-crit-block-action:hover": {
      backgroundColor: "var(--line)",
    },
    ".cm-crit-block-content > :first-child": {
      marginTop: "0",
    },
    ".cm-crit-block-content > :last-child": {
      marginBottom: "0",
    },
    ".cm-crit-block-content h1, .cm-crit-block-content h2, .cm-crit-block-content h3, .cm-crit-block-content h4, .cm-crit-block-content h5, .cm-crit-block-content h6": {
      margin: "0.35em 0 0.25em",
      color: "var(--ink)",
      fontFamily: "var(--editor-font)",
      fontWeight: "700",
      lineHeight: "1.25",
    },
    ".cm-crit-block-content h1": { fontSize: "1.55em" },
    ".cm-crit-block-content h2": { fontSize: "1.35em" },
    ".cm-crit-block-content h3": { fontSize: "1.18em" },
    ".cm-crit-block-content p": {
      margin: "0.3em 0",
    },
    ".cm-crit-block-content ul, .cm-crit-block-content ol": {
      margin: "0.3em 0",
      paddingLeft: "1.5em",
    },
    ".cm-crit-block-content ul": {
      listStyleType: "disc",
    },
    ".cm-crit-block-content ol": {
      listStyleType: "decimal",
    },
    ".cm-crit-block-content li > p": {
      margin: "0.12em 0",
    },
    ".cm-crit-block-content a": {
      color: "var(--accent)",
      textDecoration: "underline",
      textUnderlineOffset: "0.12em",
    },
    ".cm-crit-block-content code": {
      borderRadius: "3px",
      backgroundColor: "var(--panel)",
      padding: "0.08em 0.25em",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "0.9em",
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
      backgroundColor: "color-mix(in srgb, var(--crit-hl-bg) 70%, transparent)",
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
      backgroundColor: "var(--crit-hl-bg)",
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
    // Inline ✓/✗ float just above the end of their suggestion, take no room
    // in the line, and appear only on the line under the pointer (or with
    // keyboard focus), so a paragraph of suggestions reads as prose; the cards
    // keep their own buttons. Absolute with no offsets keeps the box at its
    // place in the text. Touch screens show them inline (rule below).
    ".cm-crit-controls": {
      display: "inline-flex",
      position: "absolute",
      transform: "translate(-0.6em, -1.05em)",
      gap: "2px",
      padding: "1px",
      borderRadius: "999px",
      backgroundColor: "var(--panel)",
      boxShadow: "0 1px 4px rgba(0, 0, 0, 0.18)",
      userSelect: "none",
      opacity: "0",
      pointerEvents: "none",
      transition: "opacity 120ms ease",
      zIndex: "2",
    },
    ".cm-line:hover .cm-crit-controls, .cm-crit-controls:focus-within": {
      opacity: "1",
      pointerEvents: "auto",
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
    // A long stack of dots (more than DOT_STACK_LIMIT comments in a row) folds
    // into one small pill with the count, so a busy discussion still stands out.
    ".cm-crit-comment-anchor.cm-crit-comment-anchor--count": {
      width: "auto",
      height: "auto",
      padding: "0 0.32em",
      borderRadius: "999px",
      color: "#fff",
      opacity: "0.85",
      fontFamily: "ui-sans-serif, -apple-system, system-ui, sans-serif",
      fontSize: "0.62em",
      fontWeight: "600",
      lineHeight: "1.45",
    },
    ".cm-crit-comment-anchor--folded": {
      display: "none",
    },
    // A point comment (no highlighted span) is a small "Note" pill, so it can
    // be found in the text; clicking it opens its card (#79). Two classes, so
    // the phone-width dot size below does not shrink it.
    ".cm-crit-comment-anchor.cm-crit-comment-anchor--point": {
      width: "auto",
      height: "auto",
      padding: "0 0.35em",
      borderRadius: "999px",
      color: "#fff",
      opacity: "1",
      verticalAlign: "0.1em",
      fontFamily: "ui-sans-serif, -apple-system, system-ui, sans-serif",
      fontSize: "0.68em",
      lineHeight: "1.5",
    },
    ".cm-crit-comment-anchor--point::before": {
      content: '"Note"',
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
      ".cm-md-table": {
        fontSize: "0.88em",
      },
      ".cm-md-table th, .cm-md-table td": {
        padding: "0.3em 0.24em",
      },
    },
    "@media (hover: none)": {
      ".cm-md-table-comment-add": {
        opacity: "1",
      },
      ".cm-crit-controls": {
        position: "static",
        transform: "none",
        margin: "0 0.15em 0 0.3em",
        padding: "0",
        boxShadow: "none",
        backgroundColor: "transparent",
        opacity: "1",
        pointerEvents: "auto",
      },
    },
    // Fatten inline review affordances through tablet widths. Inline controls
    // cannot reach 44px without breaking prose, but the surrounding suggestion or
    // highlighted span is also tappable, so this keeps the compact fallback usable.
    "@media (max-width: 900px)": {
      ".cm-crit-accept, .cm-crit-reject": {
        width: "1.65rem",
        height: "1.65rem",
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

// Page view (toggled in settings): the page's edges show, Docs-style — a
// panel-coloured sheet with a hairline edge and a soft shadow on a light grey
// desk — plus the page-break markers. Sits AFTER acmTheme in the extension
// array, and the earlier theme wins any shared property, so the sheet's width
// and padding are acmTheme's; this theme adds only the edges and the desk (#39).
export const pageTheme: Extension = EditorView.theme({
  ".cm-scroller": {
    backgroundColor: "var(--desk)",
    padding: "1.5rem 0 4rem",
  },
  ".cm-content": {
    backgroundColor: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: "2px",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.06)",
    minHeight: "70vh", // a fresh/short doc still reads as a page
  },
  // On a phone the page runs edge to edge: no desk margin or sheet edge.
  "@media (max-width: 640px)": {
    ".cm-scroller": {
      padding: "0.5rem 0 4rem",
      backgroundColor: "var(--panel)",
    },
    ".cm-content": {
      border: "none",
      borderRadius: "0",
      boxShadow: "none",
    },
  },
});
