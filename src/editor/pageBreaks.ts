// ── A4 page-break markers (toggled in settings) ────────────────────────────────
// A sense of how many STANDARD pages the doc fills — estimated the way a word
// processor would paginate (≈550 accepted-prose words per A4 page; 11pt
// single-spaced, the GDocs/Word ballpark), NOT by rendered screen height (the
// editor's roomy 17px/1.7 typography would inflate the count ~2×). The lib
// (pageBreakLines) decides WHERE the breaks fall, by cumulative word count; this
// plugin only renders them:
//   • a dashed divider + "p. N" label at each page boundary,
//   • a fixed "p. n / N" chip (bottom-left) tracking the page under the viewport
//     centre as you scroll.
// Word-based breaks are stable under CodeMirror's async line-height measurement —
// the count never drifts as heights settle; only divider PIXEL positions refine.

import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { pageBreakLines } from "../lib/criticmarkup";

class PageBreaksPlugin {
  overlay: HTMLDivElement;
  chip: HTMLDivElement;
  breaks: { line: number; frac: number }[] = []; // 1-based line + fraction through it
  pages = 1;
  breakTops: number[] = []; // pixel positions (scroller space) of each divider
  onScroll: () => void;

  constructor(readonly view: EditorView) {
    this.overlay = document.createElement("div");
    this.overlay.className = "cm-acm-pagebreaks";
    this.overlay.setAttribute("aria-hidden", "true");
    view.scrollDOM.appendChild(this.overlay);

    this.chip = document.createElement("div");
    this.chip.className = "cm-acm-pagechip";
    this.chip.setAttribute("aria-hidden", "true");
    // The chip is FIXED in the editor frame (doesn't scroll): parent is .cm-editor.
    view.dom.appendChild(this.chip);

    this.onScroll = () => this.updateChip();
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });

    this.recountWords();
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (u.docChanged) this.recountWords();
    if (u.docChanged || u.geometryChanged || u.viewportChanged) this.schedule();
  }

  /** Word-based pagination — doc-content-only, immune to layout jitter. */
  recountWords() {
    const { breaks, pages } = pageBreakLines(this.view.state.doc.toString());
    this.breaks = breaks;
    this.pages = pages;
  }

  /** Resolve break lines to pixel positions and (re)draw. Measure-phase reads. */
  schedule() {
    this.view.requestMeasure({
      key: "acm-pagebreaks",
      read: (view) => {
        const content = view.contentDOM;
        const doc = view.state.doc;
        const tops = this.breaks.map(({ line: lineNo, frac }) => {
          const line = doc.line(Math.min(lineNo, doc.lines));
          const block = view.lineBlockAt(line.from);
          // Interpolate inside the (soft-wrapped) line block by word fraction.
          return content.offsetTop + block.top + block.height * frac;
        });
        return {
          tops,
          left: content.offsetLeft,
          width: content.offsetWidth,
        };
      },
      write: (m) => {
        this.breakTops = m.tops;
        const frag = document.createDocumentFragment();
        m.tops.forEach((top, i) => {
          const line = document.createElement("div");
          line.className = "cm-acm-pagebreak";
          line.style.top = `${Math.round(top)}px`;
          line.style.left = `${m.left}px`;
          line.style.width = `${m.width}px`;
          const label = document.createElement("span");
          label.className = "cm-acm-pagebreak-label";
          label.textContent = `p. ${i + 2}`;
          line.appendChild(label);
          frag.appendChild(line);
        });
        this.overlay.replaceChildren(frag);
        this.updateChip();
      },
    });
  }

  /** "p. n / N" for the page under the viewport centre. */
  updateChip() {
    const sc = this.view.scrollDOM;
    const mid = sc.scrollTop + sc.clientHeight / 2;
    let page = 1;
    for (const top of this.breakTops) {
      if (top <= mid) page += 1;
      else break;
    }
    const text = `p. ${Math.min(page, this.pages)} / ${this.pages}`;
    if (this.chip.textContent !== text) this.chip.textContent = text;
    this.chip.title = `≈ ${this.pages} A4 pages at ~550 words/page (standard 11pt single-spaced)`;
  }

  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.overlay.remove();
    this.chip.remove();
  }
}

const pageBreaksTheme = EditorView.theme({
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
  // Fixed page-position chip, bottom-left of the editor frame.
  ".cm-acm-pagechip": {
    position: "absolute",
    left: "10px",
    bottom: "10px",
    zIndex: "10",
    padding: "2px 8px",
    borderRadius: "999px",
    border: "1px solid var(--line)",
    backgroundColor: "var(--panel)",
    color: "var(--muted)",
    fontSize: "11px",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    userSelect: "none",
    pointerEvents: "none",
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  },
});

/** A4 page-break markers + "p. n / N" chip, toggled from settings like page view. */
export const pageBreaks: Extension = [ViewPlugin.fromClass(PageBreaksPlugin), pageBreaksTheme];
