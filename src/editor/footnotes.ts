// ── Footnote navigation ───────────────────────────────────────────────────────
// Markdown footnotes (`[^id]` references and `[^id]: …` definitions) are plain
// text in the buffer. lezer parses a reference as a shortcut link (so the brackets
// hide and it reads as a coloured `^id`), but clicking it did nothing. This makes
// footnotes behave like the hyperlinks a reader expects: click a `[^id]` reference
// to scroll to its definition at the bottom, and click a definition's `[^id]:`
// label to scroll back to the first reference. Navigation only SCROLLS (+ briefly
// flashes the target) — it never moves the cursor, so it can't hijack editing.
//
// Implemented independently of lezer (a regex over the buffer) so it works whether
// or not a given reference happened to parse as a link. Styling uses Decoration.mark
// only (cursor affordance), which composes with markdownPreview's marks without the
// single-builder overlap that replace decorations would hit.

import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { Extension, Range } from "@codemirror/state";

/** `[^id]` — id is any run of non-bracket, non-whitespace chars. */
const FOOTNOTE_RE = /\[\^([^\]\s]+)\]/g;

interface FnToken {
  from: number;
  to: number;
  id: string;
  /** "def" = the `[^id]:` label that opens a definition line; "ref" = an inline use. */
  kind: "ref" | "def";
}

/** Footnote tokens on one line, tagged ref vs definition-label. A token is a
 *  definition label only when it starts the line (modulo indentation) AND is
 *  immediately followed by `:` — every other `[^id]` is a reference. */
function tokensInLine(lineText: string, lineFrom: number): FnToken[] {
  const out: FnToken[] = [];
  FOOTNOTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOOTNOTE_RE.exec(lineText)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const atLineStart = /^\s*$/.test(lineText.slice(0, start));
    const labelled = lineText[end] === ":";
    out.push({
      from: lineFrom + start,
      to: lineFrom + end,
      id: m[1],
      kind: atLineStart && labelled ? "def" : "ref",
    });
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The `[^id]:` definition label for `id`, or null if there's no definition. */
function findDefinition(text: string, id: string): { from: number; to: number } | null {
  const re = new RegExp(`(^|\\n)([ \\t]*)\\[\\^${escapeRegExp(id)}\\]:`, "g");
  const m = re.exec(text);
  if (!m) return null;
  const from = m.index + m[1].length + m[2].length;
  return { from, to: from + id.length + 3 }; // [ + ^ + ] around the id
}

/** The first inline `[^id]` reference for `id` (skipping the definition label),
 *  or null if it's only ever defined and never referenced. */
function findFirstReference(text: string, id: string): { from: number; to: number } | null {
  const re = new RegExp(`\\[\\^${escapeRegExp(id)}\\]`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    const lineStart = text.lastIndexOf("\n", from - 1) + 1;
    const isDefLabel = /^\s*$/.test(text.slice(lineStart, from)) && text[to] === ":";
    if (!isDefLabel) return { from, to };
  }
  return null;
}

// ── Transient "you landed here" flash on the navigation target ────────────────
const setFootnoteFlash = StateEffect.define<{ from: number; to: number } | null>();
const flashMark = Decoration.mark({ class: "cm-footnote-flash" });

const footnoteFlashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFootnoteFlash)) {
        deco = e.value ? Decoration.set([flashMark.range(e.value.from, e.value.to)]) : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const FLASH_MS = 1300;

// Bumped on every jump; the clear timer only fires if it's still the latest, so a
// rapid second jump's flash isn't cut short by the first jump's stale timer.
let flashToken = 0;

/** Scroll `target` into view and flash it, WITHOUT moving the cursor (so editing
 *  is never disturbed and a definition label stays clickable for the jump back). */
function navigateTo(view: EditorView, target: { from: number; to: number }): void {
  view.dispatch({
    effects: [EditorView.scrollIntoView(target.from, { y: "center" }), setFootnoteFlash.of(target)],
  });
  const token = ++flashToken;
  window.setTimeout(() => {
    if (token === flashToken && view.dom.isConnected) {
      view.dispatch({ effects: setFootnoteFlash.of(null) });
    }
  }, FLASH_MS);
}

// ── Click → navigate ──────────────────────────────────────────────────────────
const footnoteClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    // Primary click only, no modifiers (so shift/⌘/⌥-click keep their meaning).
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return false;
    }
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;

    const line = view.state.doc.lineAt(pos);
    // If the cursor is already on this line the user is editing it — defer to a
    // normal click (place caret / select) instead of hijacking it for navigation.
    const activeLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    if (line.number === activeLine) return false;

    const token = tokensInLine(line.text, line.from).find((t) => pos >= t.from && pos <= t.to);
    if (!token) return false;

    const text = view.state.doc.toString();
    const target =
      token.kind === "ref" ? findDefinition(text, token.id) : findFirstReference(text, token.id);
    if (!target) return false; // dangling footnote — let the click fall through

    event.preventDefault();
    navigateTo(view, target);
    return true;
  },
});

// ── Cursor affordance: mark references + definition labels as clickable ───────
const refMark = Decoration.mark({ class: "cm-footnote-ref" });
const defMark = Decoration.mark({ class: "cm-footnote-def-label" });

function buildFootnoteMarks(view: EditorView): DecorationSet {
  // Collect across visible ranges then sort — a line straddling two ranges could
  // otherwise feed the builder out-of-order / duplicate positions and throw.
  const ranges: Range<Decoration>[] = [];
  let lastLine = -1;
  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    let pos = vFrom;
    while (pos <= vTo) {
      const line = view.state.doc.lineAt(pos);
      if (line.number !== lastLine) {
        lastLine = line.number;
        for (const t of tokensInLine(line.text, line.from)) {
          ranges.push((t.kind === "def" ? defMark : refMark).range(t.from, t.to));
        }
      }
      pos = line.to + 1;
    }
  }
  ranges.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

const footnoteMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildFootnoteMarks(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildFootnoteMarks(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Footnote hyperlinks: click a `[^id]` reference to scroll to its definition and
 *  back. Styling lives in theme.ts (`.cm-footnote-ref` / `-def-label` / `-flash`). */
export const footnotes: Extension = [footnoteFlashField, footnoteMarks, footnoteClick];

/** Scroll a document range into view and flash it (same transient highlight as
 *  footnote jumps) — WITHOUT moving the cursor. Exposed so the comment sidebar can
 *  "locate" a suggestion-group member: click a row → the edited span pulses in the
 *  doc. Reuses navigateTo, so the flash timing/behaviour stays identical everywhere. */
export function flashRange(view: EditorView, from: number, to: number): void {
  navigateTo(view, { from, to });
}
