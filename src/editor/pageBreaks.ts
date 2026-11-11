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
// the count never drifts as heights settle. A boundary inside an ordinary paragraph
// snaps to the nearest line boundary (frac ≥ 0.5 → after). One inside a paragraph
// long enough to skew the page (the lib sets `offset`) stays in the paragraph, at a
// sentence start, as a block widget there too: CodeMirror then lays the paragraph
// out as separate blocks, one per page. That matters for a dictated draft that is
// one 3,000-word line (#24, #26): CodeMirror draws only part of a wrapped line over
// 20,000 characters and estimates the rest, and with suggestions on it those
// estimates never settled ("Measure loop restarted", gaps jumping as you scroll).

import { BlockType, Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { Extension, Text } from "@codemirror/state";
import { pageBreakLines, WORDS_PER_A4_PAGE } from "../lib/criticmarkup";
import { findMathRanges } from "./math";

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
  /** Doc positions of each spacer (a line start, or a sentence start inside a long
   *  paragraph), for the scroll chip. */
  positions: number[];
  pages: number;
}

function buildSpacers(doc: Text): PageBreakState {
  const { breaks, pages } = pageBreakLines(doc.toString(), WORDS_PER_A4_PAGE, findMathRanges);
  const builder = new RangeSetBuilder<Decoration>();
  const positions: number[] = [];
  let lastPos = -1;
  breaks.forEach(({ line, frac, offset }, i) => {
    // Without an offset, snap the word boundary to the nearest LINE boundary.
    const pos =
      offset !== undefined
        ? doc.line(line).from + offset
        : doc.line(Math.min(frac >= 0.5 ? line + 1 : line, doc.lines)).from;
    if (pos <= lastPos) return; // a >1-page line would stack spacers — keep one
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

  /** The gap's top in document coordinates, from the height map, so it is known
   *  outside the rendered viewport too. A line holding block widgets comes back as
   *  one block whose `type` lists its parts; the gap is the widget part at `pos`. */
  gapTop(pos: number): number {
    const block = this.view.lineBlockAt(pos);
    if (!Array.isArray(block.type)) return block.top;
    const gap = block.type.find((part) => part.from === pos && part.type !== BlockType.Text);
    return (gap ?? block).top;
  }

  updateChip() {
    // coordsAtPos reads layout, which isn't allowed during a view update.
    this.view.requestMeasure({
      key: this,
      read: () => {
        const { positions, pages } = this.view.state.field(pageBreaksField);
        const sc = this.view.scrollDOM;
        const mid = sc.getBoundingClientRect().top + sc.clientHeight / 2 - this.view.documentTop;
        let page = 1;
        for (const pos of positions) {
          if (this.gapTop(pos) <= mid) page += 1;
          else break;
        }
        return { page: Math.min(page, pages), pages };
      },
      write: ({ page, pages }) => {
        const text = `p. ${page} / ${pages}`;
        if (this.chip.textContent !== text) this.chip.textContent = text;
        this.chip.title = `≈ ${pages} A4 pages at ~${WORDS_PER_A4_PAGE} words/page (standard 11pt single-spaced)`;
      },
    });
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
  // Page view's sheet (#79): the break is a real cut, Docs-style. The gap runs
  // the sheet's full width (its 2.5rem side padding plus the 1px edge) in the
  // desk colour, so one page ends and the next begins. Vertical spacing stays
  // padding, never margin, or the height map drifts (#70).
  "@media (min-width: 641px)": {
    // White space closes the page above and opens the page below (its
    // margins); between them the desk-coloured band with soft shadows.
    ".cm-content:has(.cm-acm-pagegap) .cm-acm-pagegap": {
      display: "block",
      padding: "36px 0",
    },
    ".cm-content:has(.cm-acm-pagegap) .cm-acm-pagegap-rule": {
      display: "none",
    },
    ".cm-content:has(.cm-acm-pagegap) .cm-acm-pagegap-label": {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "44px",
      margin: "0 calc(-2.5rem - 1px)",
      backgroundColor: "var(--desk)",
      boxShadow:
        "inset 0 8px 9px -9px rgba(0, 0, 0, 0.22), inset 0 -8px 9px -9px rgba(0, 0, 0, 0.22)",
      color: "var(--faint)",
      fontSize: "10.5px",
      letterSpacing: "0.02em",
    },
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
