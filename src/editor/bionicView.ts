// ── Bionic reading mode ───────────────────────────────────────────────────────
// A rendered effect (NOT a font): bold the leading portion of each word so the
// eye fixates on word-starts. Pure CodeMirror decoration — the buffer is unchanged,
// so the .md on disk never gains markup. Toggled via a Compartment in useCodeMirror.
//
// Its own ViewPlugin / decoration set (mark-only), so it composes with — never
// collides with — the markdown + CriticMarkup decoration layers.

import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";

const boldMark = Decoration.mark({ class: "cm-bionic" });

// A "word" = a letter run (Unicode-aware), allowing internal apostrophes/hyphens.
const WORD = /\p{L}[\p{L}\p{M}'’-]*/gu;

/** How much of a word to embolden: short words get 1 char, longer ~40%. */
function boldLen(n: number): number {
  if (n <= 1) return n;
  if (n <= 3) return 1;
  return Math.ceil(n * 0.4);
}

function buildBionic(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    WORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD.exec(text)) !== null) {
      const n = boldLen(m[0].length);
      if (n > 0) builder.add(from + m.index, from + m.index + n, boldMark);
    }
  }
  return builder.finish();
}

const bionicPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildBionic(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildBionic(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export const bionicReading: Extension = bionicPlugin;
