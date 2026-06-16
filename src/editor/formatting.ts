// ── Inline formatting (⌘B bold, ⌘I italic) ───────────────────────────────────
// Google-Docs-style emphasis toggles over the markdown buffer: ⌘B wraps the
// selection in `**…**`, ⌘I in `*…*`. Each toggle is symmetric — wrap plain text,
// UNWRAP text that's already emphasised (markers inside OR just outside the
// selection), or, with an empty selection, drop the marker pair and park the
// cursor between them so you can just start typing (same as Google Docs).
//
// These MUST live in the editor keymap at higher precedence than the default
// keymap — CodeMirror's defaultKeymap binds ⌘I to `selectParentSyntax`, so a
// window-level listener would fire only AFTER that ran and would toggle emphasis
// over the wrong (re-selected) range. The keymap binding returns true, so the
// default command never runs.
//
// markdownPreview already renders StrongEmphasis/Emphasis and hides the `*`/`**`
// markers off the active line, so a toggled span reads as bold/italic the moment
// the cursor leaves its line.

import { EditorSelection } from "@codemirror/state";
import type { Command, KeyBinding } from "@codemirror/view";

/** A single ranged text edit (string-space, so the core stays unit-testable
 *  without an EditorState). */
export interface ToggleEdit {
  from: number;
  to: number;
  insert: string;
}

/** The plan for toggling one selection range: the edits to apply plus where the
 *  selection should land afterwards, expressed as if ONLY these edits applied
 *  (the idiom `state.changeByRange` expects — it maps the rest). */
export interface TogglePlan {
  edits: ToggleEdit[];
  anchor: number;
  head: number;
}

/** True when `s` is wrapped by exactly `marker` (italic `*` must not match the
 *  `**` of bold, so a single-star marker requires the adjacent char to differ). */
function isWrappedExactly(s: string, marker: string): boolean {
  if (s.length < marker.length * 2) return false;
  if (!s.startsWith(marker) || !s.endsWith(marker)) return false;
  if (marker === "*") {
    // Reject `**…**` (bold) and the degenerate `**`: the char just inside each
    // star must not itself be a star.
    if (s[1] === "*" || s[s.length - 2] === "*") return false;
  }
  return true;
}

/** True when the single char `ch` is a star — used to keep an italic `*` from
 *  binding to a neighbouring star that really belongs to a `**` run. */
const isStar = (ch: string): boolean => ch === "*";

/**
 * Plan the bold/italic toggle for one range of `doc`. Pure: returns string-space
 * edits + the resulting selection. `marker` is "*" (italic) or "**" (bold).
 */
export function planToggle(
  doc: string,
  from: number,
  to: number,
  marker: string,
): TogglePlan {
  const m = marker.length;

  // Empty selection → insert an empty pair and sit between the markers.
  if (from === to) {
    return { edits: [{ from, to, insert: marker + marker }], anchor: from + m, head: from + m };
  }

  const sel = doc.slice(from, to);

  // 1) Markers are INSIDE the selection (`*word*` selected) → strip them.
  if (isWrappedExactly(sel, marker)) {
    const inner = sel.slice(m, sel.length - m);
    return { edits: [{ from, to, insert: inner }], anchor: from, head: from + inner.length };
  }

  // 2) Markers sit JUST OUTSIDE the selection (`word` selected within `*word*`)
  //    → remove the flanking markers.
  if (from - m >= 0 && to + m <= doc.length) {
    const before = doc.slice(from - m, from);
    const after = doc.slice(to, to + m);
    let outerMatch = before === marker && after === marker;
    if (outerMatch && marker === "*") {
      // Don't peel one star off a `**bold**` wrap.
      if ((from - m - 1 >= 0 && isStar(doc[from - m - 1])) || (to + m < doc.length && isStar(doc[to + m]))) {
        outerMatch = false;
      }
    }
    if (outerMatch) {
      return {
        edits: [
          { from: from - m, to: from, insert: "" },
          { from: to, to: to + m, insert: "" },
        ],
        anchor: from - m,
        head: to - m,
      };
    }
  }

  // 3) Default → wrap. Keep markers tight against the text (markdown emphasis
  //    can't have whitespace just inside the markers), so leading/trailing
  //    whitespace in the selection stays OUTSIDE the wrap.
  const leadWs = sel.length - sel.trimStart().length;
  const trailWs = sel.length - sel.trimEnd().length;
  const coreFrom = leadWs + trailWs >= sel.length ? from : from + leadWs;
  const coreTo = leadWs + trailWs >= sel.length ? to : to - trailWs;
  return {
    edits: [
      { from: coreFrom, to: coreFrom, insert: marker },
      { from: coreTo, to: coreTo, insert: marker },
    ],
    anchor: coreFrom + m,
    head: coreTo + m,
  };
}

/** Plan the toggle across MANY ranges (multi-cursor), all in ORIGINAL document
 *  coordinates. We deliberately avoid `state.changeByRange`: it hands the callback
 *  offsets already mapped through earlier ranges' edits, but `planToggle` reads the
 *  unmapped doc string — so for 2+ cursors the later ranges would slice the wrong
 *  text. Instead we read each range against the original doc and shift its resulting
 *  selection by the net length change of all earlier ranges. */
export function planMultiToggle(
  doc: string,
  ranges: readonly { from: number; to: number }[],
  marker: string,
): { edits: ToggleEdit[]; sel: { anchor: number; head: number }[] } {
  const edits: ToggleEdit[] = [];
  const sel: { anchor: number; head: number }[] = [];
  let delta = 0; // net chars inserted by all earlier ranges
  for (const r of ranges) {
    const plan = planToggle(doc, r.from, r.to, marker);
    edits.push(...plan.edits);
    sel.push({ anchor: plan.anchor + delta, head: plan.head + delta });
    for (const e of plan.edits) delta += e.insert.length - (e.to - e.from);
  }
  return { edits, sel };
}

/** Build a CodeMirror command that toggles `marker` over every selection range. */
function toggleCommand(marker: string): Command {
  return (view) => {
    const { state } = view;
    const { edits, sel } = planMultiToggle(state.doc.toString(), state.selection.ranges, marker);
    view.dispatch({
      changes: edits,
      selection: EditorSelection.create(
        sel.map((s) => EditorSelection.range(s.anchor, s.head)),
        state.selection.mainIndex,
      ),
      scrollIntoView: true,
      userEvent: "input.format",
    });
    return true;
  };
}

/** Toggle **strong** (bold) over the selection — ⌘B. */
export const toggleStrong: Command = toggleCommand("**");
/** Toggle *emphasis* (italic) over the selection — ⌘I. */
export const toggleEmphasis: Command = toggleCommand("*");

/** The formatting keymap. Bound ahead of the default keymap so ⌘I overrides
 *  selectParentSyntax and ⌘B (otherwise unbound) takes effect. */
export const acmFormattingKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleStrong, preventDefault: true },
  { key: "Mod-i", run: toggleEmphasis, preventDefault: true },
];
