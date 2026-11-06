// ── Bionic reading mode ───────────────────────────────────────────────────────
// A rendered effect (NOT a font): bold the leading portion of each word so the
// eye fixates on word-starts. Pure CodeMirror decoration — the buffer is unchanged,
// so the .md on disk never gains markup. Toggled via a Compartment in useCodeMirror.
//
// Its own ViewPlugin / decoration set (mark-only), so it composes with — never
// collides with — the markdown + CriticMarkup decoration layers.

import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { LITERAL_NODES } from "../lib/markdownLiteralRanges";
import { SKIP_NODES, overlapsSkip } from "../lib/spellModel";
import type { Span } from "../lib/spellModel";

const boldMark = Decoration.mark({ class: "cm-bionic" });

// A "word" = a letter run (Unicode-aware), allowing internal apostrophes/hyphens.
const WORD = /\p{L}[\p{L}\p{M}'’-]*/gu;

// Regions bionic leaves alone (#69): the literal ranges the spellchecker and
// export skip (code, HTML, URLs), plus every CriticMarkup span. A bionic mark
// inside a styled span splits it into one element per fragment, and each
// fragment then draws its own padded box (inline code read as "gen | img").
const BIONIC_SKIP_NODES = new Set<string>([
  ...LITERAL_NODES,
  ...SKIP_NODES,
  "CMInsert",
  "CMDelete",
  "CMSubstitute",
  "CMHighlight",
]);

/** How much of a word to embolden: short words get 1 char, longer ~40%. */
function boldLen(n: number): number {
  if (n <= 1) return n;
  if (n <= 3) return 1;
  return Math.ceil(n * 0.4);
}

function skipSpans(state: EditorState, from: number, to: number): Span[] {
  const spans: Span[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (!BIONIC_SKIP_NODES.has(node.name)) return undefined;
      spans.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return spans;
}

/** The emboldened word-leads in [from, to), in document order. */
export function bionicRanges(state: EditorState, from: number, to: number): Span[] {
  const skip = skipSpans(state, from, to);
  const text = state.sliceDoc(from, to);
  const out: Span[] = [];
  WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(text)) !== null) {
    const start = from + m.index;
    if (overlapsSkip(skip, start, start + m[0].length)) continue;
    const n = boldLen(m[0].length);
    if (n > 0) out.push({ from: start, to: start + n });
  }
  return out;
}

function buildBionic(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (const range of bionicRanges(view.state, from, to)) {
      builder.add(range.from, range.to, boldMark);
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
      if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState))
        this.decorations = buildBionic(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export const bionicReading: Extension = bionicPlugin;
