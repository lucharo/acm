// ── A4 page-break markers (toggled in settings) ────────────────────────────────
// Draws a dashed divider + page number every "A4 page" of rendered content, plus
// an "≈ N A4 pages" tally under the last line — a sense of how many pages the doc
// fills, like Word/GDocs page view, WITHOUT real pagination (CodeMirror renders
// one continuous document; true page boxes aren't possible).
//
// Page height = rendered content width × √2 (the A4 aspect ratio) — so what you
// see corresponds to "this text block, printed at this width, on A4". An
// approximation by design: real print margins/fonts will differ.
//
// Mechanics: one absolutely-positioned overlay div appended to .cm-scroller
// (made position:relative by the theme), so the markers scroll with the content.
// Recomputed on geometry/doc changes via requestMeasure — read in the measure
// phase, DOM writes in the write phase, never mid-update.

import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

const SQRT2 = Math.SQRT2; // A4 aspect: height = width × √2

class PageBreaksPlugin {
  overlay: HTMLDivElement;

  constructor(readonly view: EditorView) {
    this.overlay = document.createElement("div");
    this.overlay.className = "cm-acm-pagebreaks";
    this.overlay.setAttribute("aria-hidden", "true");
    view.scrollDOM.appendChild(this.overlay);
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.geometryChanged || u.viewportChanged) this.schedule();
  }

  schedule() {
    this.view.requestMeasure({
      key: "acm-pagebreaks",
      read: (view) => {
        const content = view.contentDOM;
        // offsetParent is the (position:relative) scroller, so these offsets are
        // directly usable for absolutely-positioned overlay children.
        return {
          top: content.offsetTop,
          left: content.offsetLeft,
          width: content.offsetWidth,
          height: content.offsetHeight,
        };
      },
      write: (m) => {
        const pageH = m.width * SQRT2;
        if (!(pageH > 0) || !(m.height > 0)) return;
        const pages = Math.max(1, Math.ceil(m.height / pageH));
        const frag = document.createDocumentFragment();
        for (let k = 1; k * pageH < m.height; k++) {
          const line = document.createElement("div");
          line.className = "cm-acm-pagebreak";
          line.style.top = `${Math.round(m.top + k * pageH)}px`;
          line.style.left = `${m.left}px`;
          line.style.width = `${m.width}px`;
          const label = document.createElement("span");
          label.className = "cm-acm-pagebreak-label";
          label.textContent = `p. ${k + 1}`;
          line.appendChild(label);
          frag.appendChild(line);
        }
        const tally = document.createElement("div");
        tally.className = "cm-acm-pagetally";
        tally.style.top = `${Math.round(m.top + m.height + 6)}px`;
        tally.style.left = `${m.left}px`;
        tally.style.width = `${m.width}px`;
        tally.textContent = `≈ ${pages} A4 page${pages === 1 ? "" : "s"}`;
        frag.appendChild(tally);
        this.overlay.replaceChildren(frag);
      },
    });
  }

  destroy() {
    this.overlay.remove();
  }
}

const pageBreaksTheme = EditorView.theme({
  // The overlay's children are positioned against the scroller (made relative in
  // acmTheme); the overlay itself is just a transparent grouping node.
  ".cm-acm-pagebreaks": {
    pointerEvents: "none",
  },
  ".cm-acm-pagebreak": {
    position: "absolute",
    borderTop: "1.5px dashed var(--line-strong)",
    zIndex: "3",
  },
  ".cm-acm-pagebreak-label": {
    position: "absolute",
    right: "0",
    top: "2px",
    fontSize: "10px",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    color: "var(--faint)",
    userSelect: "none",
  },
  ".cm-acm-pagetally": {
    position: "absolute",
    textAlign: "right",
    fontSize: "11px",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    color: "var(--muted)",
    userSelect: "none",
    pointerEvents: "none",
  },
});

/** A4 page-break markers + page tally, toggled from settings like the page view. */
export const pageBreaks: Extension = [ViewPlugin.fromClass(PageBreaksPlugin), pageBreaksTheme];
