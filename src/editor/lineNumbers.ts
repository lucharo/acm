// ── Line numbers ──────────────────────────────────────────────────────────────
// Optional, toggled in settings. Each number is generated content at the start
// of its own line, hung left into the page's padding. Being in the line means it
// shares the first baseline at any heading size and is never selected or copied.
// A CodeMirror gutter can't do this: it sits outside the page and top-aligns each
// number in its line's block.

import { Prec, RangeSetBuilder } from "@codemirror/state";
import type { Extension, Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";

/** One numbered line decoration per document line touching `ranges`. An empty
 * document reports no visible ranges, yet still has a first line to number. */
export function lineNumberDecorations(
  doc: Text,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let last = 0;
  for (const { from, to } of ranges.length ? ranges : [{ from: 0, to: 0 }]) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (line.number > last) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({ attributes: { "data-ln": String(line.number) } }),
        );
        last = line.number;
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const numberPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = lineNumberDecorations(view.state.doc, view.visibleRanges);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = lineNumberDecorations(update.state.doc, update.view.visibleRanges);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// Width plus both margins must net to zero so the number takes no room in the
// line. A block quote starts its text further in; --cm-ln-inset (theme.ts) cancels
// that so every number keeps the same column.
const numberTheme = Prec.high(
  EditorView.theme({
    ".cm-line[data-ln]::before": {
      content: "attr(data-ln)",
      display: "inline-block",
      width: "2rem",
      marginLeft: "calc(-2.65rem - var(--cm-ln-inset, 0px))",
      marginRight: "calc(0.65rem + var(--cm-ln-inset, 0px))",
      textAlign: "right",
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      fontVariantNumeric: "tabular-nums",
      fontSize: "11px",
      fontWeight: "400",
      fontStyle: "normal",
      lineHeight: "1",
      color: "color-mix(in srgb, var(--ink) 32%, transparent)",
      userSelect: "none",
      pointerEvents: "none",
    },
    // Empty alt text keeps the numbers out of what screen readers announce.
    '@supports (content: "x" / "")': {
      ".cm-line[data-ln]::before": { content: 'attr(data-ln) / ""' },
    },
    // A phone's page margin is too narrow for the column, so widen it.
    "@media (max-width: 640px)": {
      ".cm-content": { paddingLeft: "2.25rem" },
      ".cm-line[data-ln]::before": {
        width: "1.6rem",
        marginLeft: "calc(-2rem - var(--cm-ln-inset, 0px))",
        marginRight: "calc(0.4rem + var(--cm-ln-inset, 0px))",
        fontSize: "10px",
      },
    },
  }),
);

export const documentLineNumbers: Extension = [numberPlugin, numberTheme];
