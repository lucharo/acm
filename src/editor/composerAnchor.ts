// ── Selection anchor while composing ─────────────────────────────────────────
// Native browser selection disappears when focus moves from CodeMirror into the
// comment/suggestion textarea. Keep a mapped visual mark over the captured range
// for exactly that interval; the document and CodeMirror selection stay unchanged.

import { Prec, StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

interface ComposerAnchorRange {
  from: number;
  to: number;
}

export const setComposerAnchor = StateEffect.define<ComposerAnchorRange | null>({
  map(value, changes) {
    if (!value) return null;
    const from = changes.mapPos(value.from, 1);
    const to = changes.mapPos(value.to, -1);
    return to > from ? { from, to } : null;
  },
});

const composerAnchorMark = Decoration.mark({ class: "cm-composer-anchor" });

export const composerAnchorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setComposerAnchor)) continue;
      const range = effect.value;
      if (!range) return Decoration.none;
      const from = Math.max(0, Math.min(range.from, transaction.state.doc.length));
      const to = Math.max(from, Math.min(range.to, transaction.state.doc.length));
      return to > from
        ? Decoration.set([composerAnchorMark.range(from, to)])
        : Decoration.none;
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Highest precedence keeps the blue composing mark inside Markdown/CriticMarkup
// presentation marks, so their own backgrounds cannot cover it.
export const composerAnchorExtension: Extension = Prec.highest(composerAnchorField);

export type { ComposerAnchorRange };
