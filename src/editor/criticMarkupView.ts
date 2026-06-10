// ── CriticMarkup decoration + widget layer ────────────────────────────────────
// Reads the CMInsert/CMDelete/CMSubstitute/CMHighlight/CMComment nodes produced
// by criticMarkupParser.ts and turns them into the visible editor UI:
//
//   • coloured MARK decorations (green ins, red-strike del, split substitution,
//     yellow highlight) — provided via EditorView.outerDecorations so they WRAP
//     (not fragment) the markdown styling underneath.
//   • inline ✓ / ✗ AcceptRejectWidget after each suggestion (ins/del/sub).
//   • a clickable 💬 CommentAnchorWidget that REPLACES (hides) the raw comment
//     markup — stacked comments produce several adjacent bubbles in a row.
//   • atomicRanges over the hidden comment markup so the cursor skips it and
//     backspace removes the whole construct, not half a delimiter.
//
// Overlap rule (CRITICAL): MARK decorations and REPLACE/WIDGET decorations over
// the same/adjacent ranges must live in SEPARATE RangeSetBuilders or they crash.
// So this module ships two ViewPlugins: one builds the marks (→ outerDecorations),
// the other builds widgets + comment-hide replaces (→ regular decorations) and
// owns click handling + atomic ranges.
//
// The editor only REPORTS clicks (with offsets) via the critCallbacksFacet — it
// never mutates the document. App owns mutation (it calls lib/criticmarkup +
// dispatches the ranged edit + writes the file).

import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { Facet, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { Extension, Range, RangeSet } from "@codemirror/state";
import { inlineSuggestions } from "../lib/criticmarkup";
import type { InlineSuggestion } from "../lib/criticmarkup";

// ── Active / seen highlight state (App → editor bridge) ───────────────────────
// App tells the editor which comment-anchor highlights are ACTIVE (selected) or
// SEEN, keyed by the highlight's `from` offset, so the mark layer can style them.
// Colourblind-safe styling lives in theme.ts (lightness + texture, not hue).
export interface CritHighlightState {
  active: number | null; // `from` of the active comment's anchor highlight
  seen: Set<number>; // `from`s of seen comments' anchor highlights
  busy: Set<number>; // `from`s of anchors carrying a multi-comment thread (density)
}
export const setCritHighlights = StateEffect.define<{
  active: number | null;
  seen: number[];
  busy: number[];
}>();
export const critHighlightField = StateField.define<CritHighlightState>({
  create: () => ({ active: null, seen: new Set<number>(), busy: new Set<number>() }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setCritHighlights))
        return { active: e.value.active, seen: new Set(e.value.seen), busy: new Set(e.value.busy) };
    }
    // Edits shift every anchor offset; map the keys through the change so the
    // active/seen/busy styling stays glued to its highlight until App's next
    // authoritative push (which re-derives the keys from fresh tokens).
    if (tr.docChanged) {
      const map = (p: number) => tr.changes.mapPos(p);
      return {
        active: value.active === null ? null : map(value.active),
        seen: new Set([...value.seen].map(map)),
        busy: new Set([...value.busy].map(map)),
      };
    }
    return value;
  },
});

// ── Inline-suggestion state (derived from the doc) ────────────────────────────
// The anchored SUGGEST: pairs, recomputed from the document itself on every doc
// change (the lib scan is one pure O(n) pass — cheap at document scale). The
// decoration layer stays presentational: it places marks / widgets on REAL lezer
// nodes and only consults this list to CLASSIFY which highlight is a struck
// suggestion-span and which comment is an inline suggestion. Deriving in-state
// (rather than a React round-trip) means classification can never lag the doc —
// no one-frame flicker of suggestion widgets collapsing to plain dots.
export const inlineSuggestionsField = StateField.define<InlineSuggestion[]>({
  create: (state) => inlineSuggestions(state.doc.toString()),
  update(value, tr) {
    return tr.docChanged ? inlineSuggestions(tr.newDoc.toString()) : value;
  },
});

// ── Callbacks contract (App supplies these) ───────────────────────────────────
export interface CritCallbacks {
  onAccept(from: number, to: number): void;
  onReject(from: number, to: number): void;
  onCommentClick(from: number, to: number): void;
  /** Accept a SUGGEST: pair — (from,to) is the comment range. */
  onAcceptSuggestion(from: number, to: number): void;
  /** Reject a SUGGEST: pair — keep the original span. (from,to) = comment range. */
  onRejectSuggestion(from: number, to: number): void;
}

const noop = () => {};

/**
 * Facet carrying the active click callbacks into the editor. App provides it via
 * `critCallbacksFacet.of(callbacks)`; the widget plugin reads the combined value
 * with `view.state.facet(critCallbacksFacet)`. Combining keeps the LAST provided
 * value so a reconfigure (fresh callbacks) wins without recreating the view.
 */
export const critCallbacksFacet = Facet.define<CritCallbacks, CritCallbacks>({
  combine: (values) =>
    values.length
      ? values[values.length - 1]
      : {
          onAccept: noop,
          onReject: noop,
          onCommentClick: noop,
          onAcceptSuggestion: noop,
          onRejectSuggestion: noop,
        },
});

// ── Widgets ───────────────────────────────────────────────────────────────────

/** ✓ / ✗ controls rendered after a suggestion. Carries the node [from,to). */
class AcceptRejectWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }
  eq(other: AcceptRejectWidget) {
    return other.from === this.from && other.to === this.to;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-crit-controls";
    wrap.setAttribute("contenteditable", "false");

    const accept = document.createElement("span");
    accept.className = "cm-crit-accept";
    accept.textContent = "✓";
    accept.title = "Accept";
    accept.setAttribute("data-from", String(this.from));
    accept.setAttribute("data-to", String(this.to));

    const reject = document.createElement("span");
    reject.className = "cm-crit-reject";
    reject.textContent = "✗";
    reject.title = "Reject";
    reject.setAttribute("data-from", String(this.from));
    reject.setAttribute("data-to", String(this.to));

    wrap.appendChild(accept);
    wrap.appendChild(reject);
    return wrap;
  }
  ignoreEvent() {
    return false; // let mousedown reach the plugin's eventHandlers
  }
}

/** A small speech-bubble glyph standing in for hidden comment markup. */
class CommentAnchorWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }
  eq(other: CommentAnchorWidget) {
    return other.from === this.from && other.to === this.to;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-crit-comment-anchor";
    el.title = "View comment";
    el.setAttribute("contenteditable", "false");
    el.setAttribute("data-from", String(this.from));
    el.setAttribute("data-to", String(this.to));
    return el; // visual is a CSS dot (theme.ts); no text content
  }
  ignoreEvent() {
    return false;
  }
}

/**
 * Inline rendering of a SUGGEST: pair, REPLACING the comment markup: the proposed
 * wording in green (or "(delete)" for an empty replacement) + ✓ / ✗ controls —
 * visually a native substitution's "new" half, since semantically it IS one. The
 * struck "old" half is the anchor highlight, restyled by buildMarks. When a real
 * discussion thread hangs off the suggestion, a trailing dot opens it (the unified
 * render must not hide that replies exist). Carries the comment [from,to) so the
 * controls dispatch the accept/reject edit against the right comment.
 */
class SuggestionInlineWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly replacement: string,
    readonly threadCount: number,
    readonly alternativeIndex: number,
    readonly groupId: string | null,
    readonly groupSize: number,
  ) {
    super();
  }
  eq(other: SuggestionInlineWidget) {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.replacement === this.replacement &&
      other.threadCount === this.threadCount &&
      other.alternativeIndex === this.alternativeIndex &&
      other.groupId === this.groupId &&
      other.groupSize === this.groupSize
    );
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-crit-suggest";
    wrap.setAttribute("contenteditable", "false");

    if (this.alternativeIndex > 0) {
      // A COMPETING suggestion on the same span — separate it from the previous
      // one so two proposals never read as one concatenated wording.
      const or = document.createElement("span");
      or.className = "cm-crit-suggest-or";
      or.textContent = "or";
      wrap.appendChild(or);
    }

    const neu = document.createElement("span");
    if (this.replacement.trim()) {
      neu.className = "cm-crit-sub-new cm-crit-suggest-new";
      neu.textContent = this.replacement;
    } else {
      neu.className = "cm-crit-suggest-del";
      neu.textContent = "(delete)";
    }
    wrap.appendChild(neu);

    const controls = document.createElement("span");
    controls.className = "cm-crit-controls";
    const accept = document.createElement("span");
    accept.className = "cm-crit-accept cm-crit-suggest-accept";
    accept.textContent = "✓";
    accept.title = "Accept — replace the span with the suggestion";
    accept.setAttribute("data-from", String(this.from));
    accept.setAttribute("data-to", String(this.to));
    const reject = document.createElement("span");
    reject.className = "cm-crit-reject cm-crit-suggest-reject";
    reject.textContent = "✗";
    reject.title = "Reject — keep the original span";
    reject.setAttribute("data-from", String(this.from));
    reject.setAttribute("data-to", String(this.to));
    controls.appendChild(accept);
    controls.appendChild(reject);
    wrap.appendChild(controls);

    if (this.groupId && this.groupSize > 1) {
      // Member of a suggestion group — a set meant to be accepted/rejected as one
      // unit. Informational chip; the group-wide controls live on the sidebar card.
      const chip = document.createElement("span");
      chip.className = "cm-crit-suggest-group";
      chip.textContent = `⛓${this.groupSize}`;
      chip.title = `Part of suggestion group “${this.groupId}” — ${this.groupSize} edits meant to be applied together (group controls on the sidebar card)`;
      wrap.appendChild(chip);
    }

    if (this.threadCount > 1) {
      // A discussion hangs off this suggestion — show the message COUNT so accepting
      // inline doesn't silently bypass an unread parent/sibling comment. Clickable →
      // opens the thread. Carries the comment-click classes so the handler routes it.
      const badge = document.createElement("span");
      badge.className = "cm-crit-comment-anchor cm-crit-suggest-thread";
      badge.textContent = `💬 ${this.threadCount}`;
      badge.title = `${this.threadCount} messages in this thread — view discussion`;
      badge.setAttribute("data-from", String(this.from));
      badge.setAttribute("data-to", String(this.to));
      wrap.appendChild(badge);
    }
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

// ── MARK plugin (→ outerDecorations) ──────────────────────────────────────────
// Pure colouring marks. By going through EditorView.outerDecorations these wrap
// AROUND the markdown style marks, so e.g. bold-inside-insertion keeps both.
function buildMarks(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const insMark = Decoration.mark({ class: "cm-crit-ins" });
  const delMark = Decoration.mark({ class: "cm-crit-del" });
  const subOld = Decoration.mark({ class: "cm-crit-sub-old" });
  const subNew = Decoration.mark({ class: "cm-crit-sub-new" });
  const hlState = view.state.field(critHighlightField, false);
  // Anchor highlights of SUGGEST: pairs render as a substitution's struck "old"
  // half (the proposed wording is shown by the inline widget), not yellow.
  const suggestHls = new Set(
    (view.state.field(inlineSuggestionsField, false) ?? []).map((s) => s.hlFrom),
  );

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: vFrom,
      to: vTo,
      enter: (node) => {
        switch (node.name) {
          case "CMInsert":
            ranges.push(insMark.range(node.from, node.to));
            return false;
          case "CMDelete":
            ranges.push(delMark.range(node.from, node.to));
            return false;
          case "CMHighlight": {
            // A SUGGEST: anchor → strike it like a substitution's old half (unified
            // render); the inline widget supplies the green "new" half. Still
            // DESCEND so any nested constructs inside the span get their marks.
            if (suggestHls.has(node.from)) {
              ranges.push(subOld.range(node.from, node.to));
              return;
            }
            // Mark the whole anchor yellow, then DESCEND (no `return false`): a
            // highlight may nest other highlights (stacked comment threads) or wrap
            // tracked changes (`{==text {++ins++}==}`), and those inner constructs
            // need their own marks. Overlapping marks nest fine in one RangeSet.
            // The active comment's anchor + seen anchors get extra classes (styled,
            // colourblind-safe, in theme.ts).
            const classes = ["cm-crit-hl"];
            if (hlState && node.from === hlState.active) classes.push("cm-crit-hl--active");
            else if (hlState && hlState.seen.has(node.from)) classes.push("cm-crit-hl--seen");
            // Density: a span carrying a multi-comment thread reads a shade heavier
            // (lightness, colourblind-safe) — GDocs shades busier regions darker.
            if (hlState && hlState.busy.has(node.from)) classes.push("cm-crit-hl--busy");
            ranges.push(Decoration.mark({ class: classes.join(" ") }).range(node.from, node.to));
            return;
          }
          case "CMSubstitute": {
            // Split at the arrow: old half struck, new half green. The arrow
            // node sits between them; we colour [from,arrowStart) and
            // [arrowEnd,to).
            const arrow = node.node.getChild("CMSubArrow");
            const splitL = arrow ? arrow.from : node.to;
            const splitR = arrow ? arrow.to : node.to;
            if (splitL > node.from) ranges.push(subOld.range(node.from, splitL));
            if (node.to > splitR) ranges.push(subNew.range(splitR, node.to));
            return false;
          }
          default:
            return; // descend into non-crit nodes
        }
      },
    });
  }

  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

// NOTE: this plugin's decorations are fed into EditorView.outerDecorations
// (so they WRAP markdown styling), NOT into the standard decoration layer — so
// we deliberately do NOT pass a `decorations` accessor in the plugin spec.
const markPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMarks(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.startState.field(critHighlightField, false) !== u.state.field(critHighlightField, false) ||
        u.startState.field(inlineSuggestionsField, false) !== u.state.field(inlineSuggestionsField, false)
      ) {
        this.decorations = buildMarks(u.view);
      }
    }
  },
);

// ── WIDGET + COMMENT-HIDE plugin (→ regular decorations) ──────────────────────
function buildWidgets(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  // SUGGEST: comments → an inline suggestion widget (proposed wording + ✓/✗)
  // instead of the plain 💬 bubble. Keyed by the comment's start offset.
  const suggestByComment = new Map(
    (view.state.field(inlineSuggestionsField, false) ?? []).map((s) => [s.commentFrom, s]),
  );

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: vFrom,
      to: vTo,
      enter: (node) => {
        switch (node.name) {
          case "CMInsert":
          case "CMDelete":
          case "CMSubstitute": {
            // Widget sits at the node's end, side 1 (after the markup).
            ranges.push(
              Decoration.widget({
                widget: new AcceptRejectWidget(node.from, node.to),
                side: 1,
              }).range(node.to),
            );
            return false;
          }
          case "CMComment": {
            // A SUGGEST: comment → inline suggestion widget (proposed wording +
            // ✓/✗), so an anchored suggestion reads exactly like a native
            // substitution. Otherwise the plain clickable bubble. Stacked comments
            // → several adjacent replaces with DISTINCT ranges (no overlap).
            const sug = suggestByComment.get(node.from);
            ranges.push(
              Decoration.replace({
                widget: sug
                  ? new SuggestionInlineWidget(
                      node.from,
                      node.to,
                      sug.replacement,
                      sug.threadCount,
                      sug.alternativeIndex,
                      sug.groupId,
                      sug.groupSize,
                    )
                  : new CommentAnchorWidget(node.from, node.to),
              }).range(node.from, node.to),
            );
            return false;
          }
          default:
            return;
        }
      },
    });
  }

  // widget(side:1) points at `to`; replace spans [from,to). Sort by from then
  // startSide so the builder receives a valid increasing order.
  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

const widgetPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildWidgets(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.startState.field(inlineSuggestionsField, false) !== u.state.field(inlineSuggestionsField, false)
      ) {
        this.decorations = buildWidgets(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = event.target as HTMLElement | null;
        if (!target) return false;
        const fromAttr = target.getAttribute("data-from");
        const toAttr = target.getAttribute("data-to");
        if (fromAttr === null || toAttr === null) return false;
        const from = Number(fromAttr);
        const to = Number(toAttr);
        const cb = view.state.facet(critCallbacksFacet);
        // SUGGEST: controls carry BOTH the shared pill class and a suggest-specific
        // one — check the specific class FIRST so they route to the suggestion
        // accept/reject (keep span vs replace), not the generic node accept/reject.
        if (target.classList.contains("cm-crit-suggest-accept")) {
          cb.onAcceptSuggestion(from, to);
        } else if (target.classList.contains("cm-crit-suggest-reject")) {
          cb.onRejectSuggestion(from, to);
        } else if (target.classList.contains("cm-crit-accept")) {
          cb.onAccept(from, to);
        } else if (target.classList.contains("cm-crit-reject")) {
          cb.onReject(from, to);
        } else if (target.classList.contains("cm-crit-comment-anchor")) {
          cb.onCommentClick(from, to);
        } else {
          return false;
        }
        // Stop CM from moving the cursor into the (hidden) markup.
        event.preventDefault();
        return true;
      },
    },
  },
);

// ── Atomic ranges over hidden markup ──────────────────────────────────────────
// Goal: the cursor never lands inside HIDDEN markup, and Backspace/Delete never
// leaves a half-deleted construct — WITHOUT preventing you from selecting or
// double-clicking the visible inner text (full-construct atomicity broke that).
//
// So: comments (replaced by the 💬 dot, no editable interior) are atomic as a
// whole; suggestion/highlight DELIMITERS are atomic (cursor skips the hidden
// braces, inner text stays selectable/editable). The remaining hole — Backspace at
// the inner edge deleting a lone delimiter — is closed by criticEditKeymap below,
// which removes the WHOLE construct at a delimiter boundary instead.

const HIDDEN_DELIM_NODES = new Set<string>([
  "CMInsertOpen",
  "CMInsertClose",
  "CMDeleteOpen",
  "CMDeleteClose",
  // Single nesting-aware highlight delimiter (both `{==` and `==}`).
  "CMHighlightMark",
  "CMSubOpen",
  "CMSubClose",
  "CMSubArrow",
]);

const criticAtomicRanges = EditorView.atomicRanges.of((view): RangeSet<Decoration> => {
  const ranges: Range<Decoration>[] = [];
  const filler = Decoration.replace({});
  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: vFrom,
      to: vTo,
      enter: (node) => {
        if (node.name === "CMComment") {
          ranges.push(filler.range(node.from, node.to));
          return false; // whole comment is atomic (no editable interior)
        }
        if (HIDDEN_DELIM_NODES.has(node.name)) {
          ranges.push(filler.range(node.from, node.to)); // hidden delimiter — skip over
          return false;
        }
        return;
      },
    });
  }
  ranges.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
});

/**
 * The full CriticMarkup view layer: marks (wrapping, via outerDecorations) +
 * widgets/comment-hide (regular decorations, with click handling) + atomic
 * ranges. App composes this with markdownPreview, acmTheme, and the markdown
 * language configured with the CriticMarkup lezer extension.
 */
export function criticMarkupExtension(): Extension {
  return [
    critHighlightField,
    inlineSuggestionsField,
    EditorView.outerDecorations.of((view) =>
      view.plugin(markPlugin)?.decorations ?? Decoration.none,
    ),
    markPlugin,
    widgetPlugin,
    criticAtomicRanges,
  ];
}
