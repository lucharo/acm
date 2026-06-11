// ── A4 page-break markers (toggled in settings) ────────────────────────────────
// A sense of how many STANDARD pages the doc fills — estimated the way a word
// processor would paginate (≈550 accepted-prose words per A4 page; 11pt
// single-spaced, the GDocs/Word ballpark), NOT by rendered screen height (the
// editor's roomy 17px/1.7 typography would inflate the count ~2×). The lib
// (pageBreakLines) decides WHERE the breaks fall, by cumulative word count.
//
// Rendered as REAL page gaps: small block-widget spacers (dashed rule + "p. N"
// label) between lines, GDocs-style — so the break adds a little breathing room
// instead of striking text through. Block widgets affect vertical layout, which
// CM6 only permits from a StateField (not a view plugin), so the spacers live in
// one; the "p. n / N" scroll chip is a separate DOM-only plugin.
//
// Word-based breaks are stable under CodeMirror's async line-height measurement —
// the count never drifts as heights settle. A boundary that falls inside a long
// soft-wrapped paragraph snaps to the nearest line boundary (frac ≥ 0.5 → after).

import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { Extension, Text } from "@codemirror/state";
import { pageBreakLines, WORDS_PER_A4_PAGE } from "../lib/criticmarkup";

/** The spacer between pages: a slim gap with a dashed rule + "p. N" label. */
class PageGapWidget extends WidgetType {
  constructor(readonly page: number) {
    super();
  }
  eq(other: PageGapWidget) {
    return other.page === this.page;
  }
  toDOM() {
    const gap = document.createElement("div");
    gap.className = "cm-acm-pagegap";
    gap.setAttribute("aria-hidden", "true");
    const rule = document.createElement("div");
    rule.className = "cm-acm-pagegap-rule";
    const label = document.createElement("span");
    label.className = "cm-acm-pagegap-label";
    label.textContent = `p. ${this.page}`;
    gap.appendChild(rule);
    gap.appendChild(label);
    return gap;
  }
  get estimatedHeight() {
    return 30;
  }
  ignoreEvent() {
    return true;
  }
}

interface PageBreakState {
  deco: DecorationSet;
  /** Doc positions (line starts) of each spacer, for the scroll chip. */
  positions: number[];
  pages: number;
}

function buildSpacers(doc: Text): PageBreakState {
  const { breaks, pages } = pageBreakLines(doc.toString());
  const builder = new RangeSetBuilder<Decoration>();
  const positions: number[] = [];
  let lastPos = -1;
  breaks.forEach(({ line, frac }, i) => {
    // Snap the word boundary to the nearest LINE boundary (block widgets live
    // between lines; sub-line precision isn't possible without real pagination).
    const target = Math.min(frac >= 0.5 ? line + 1 : line, doc.lines);
    const pos = doc.line(target).from;
    if (pos === lastPos) return; // a >1-page line would stack spacers — keep one
    lastPos = pos;
    positions.push(pos);
    builder.add(pos, pos, Decoration.widget({ widget: new PageGapWidget(i + 2), side: -1, block: true }));
  });
  return { deco: builder.finish(), positions, pages };
}

const pageBreaksField = StateField.define<PageBreakState>({
  create: (state) => buildSpacers(state.doc),
  update: (value, tr) => (tr.docChanged ? buildSpacers(tr.newDoc) : value),
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// ── "p. n / N" chip — fixed bottom-left, tracks the page under viewport centre ──
class PageChipPlugin {
  chip: HTMLDivElement;
  onScroll: () => void;

  constructor(readonly view: EditorView) {
    this.chip = document.createElement("div");
    this.chip.className = "cm-acm-pagechip";
    this.chip.setAttribute("aria-hidden", "true");
    view.dom.appendChild(this.chip);
    this.onScroll = () => this.updateChip();
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.updateChip();
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.geometryChanged) this.updateChip();
  }

  updateChip() {
    const { positions, pages } = this.view.state.field(pageBreaksField);
    const sc = this.view.scrollDOM;
    const mid = sc.scrollTop + sc.clientHeight / 2 - this.view.documentTop;
    let page = 1;
    for (const pos of positions) {
      if (this.view.lineBlockAt(pos).top <= mid) page += 1;
      else break;
    }
    const text = `p. ${Math.min(page, pages)} / ${pages}`;
    if (this.chip.textContent !== text) this.chip.textContent = text;
    this.chip.title = `≈ ${pages} A4 pages at ~${WORDS_PER_A4_PAGE} words/page (standard 11pt single-spaced)`;
  }

  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.chip.remove();
  }
}

const pageBreaksTheme = EditorView.theme({
  // The page gap: real vertical space between "pages" (GDocs-like), with the
  // dashed rule + label inside it.
  ".cm-acm-pagegap": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "13px 0",
    userSelect: "none",
    pointerEvents: "none",
  },
  ".cm-acm-pagegap-rule": {
    flex: "1",
    borderTop: "1.5px dashed var(--line-strong)",
  },
  ".cm-acm-pagegap-label": {
    fontSize: "10px",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    color: "var(--faint)",
    lineHeight: "1",
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

/** A4 page-break spacers + "p. n / N" chip, toggled from settings like page view. */
export const pageBreaks: Extension = [
  pageBreaksField,
  ViewPlugin.fromClass(PageChipPlugin),
  pageBreaksTheme,
];
