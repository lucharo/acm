// ── Editing around hidden CriticMarkup (rich view only) ───────────────────────
// The rich view hides `{==`, `==}`, `{++`… and draws each comment as a marker,
// and those hidden pieces are atomic ranges so the caret skips them. Left alone,
// CodeMirror's delete commands then delete the nearest atomic range: Backspace
// at the visible end of a commented word removed the comment, and Backspace just
// inside a delimiter removed that delimiter alone, breaking the markup (#43).
//
// Three rules fix that:
//   • criticDeleteKeymap: Backspace / Delete and the word deletes at the edge of
//     a hidden run hop over the run first, then delete as usual, so they edit
//     the visible text. Line deletes take everything visible to the line edge,
//     markers included. Otherwise deleting a comment stays explicit: Resolve on
//     its card, or a selection that covers its marker.
//   • criticEditGuard: a user edit that covers PART of a construct keeps the
//     construct's delimiters (and a highlight's comments, when it touches the
//     highlighted text), deleting only the visible text it covers; a construct
//     left with no visible text goes, its comments staying as point comments.
//   • criticClipboardFilter: copy, cut and drag carry the same visible text, so
//     pasting or dropping it never brings a stray `==}` or a duplicate comment.
// Edits without a user event (accept/reject, remote writes) pass through.

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, Prec, Transaction } from "@codemirror/state";
import type { ChangeSpec, Extension, TransactionSpec } from "@codemirror/state";
import {
  deleteCharBackward,
  deleteCharForward,
  deleteGroupBackward,
  deleteGroupForward,
  deleteLineBoundaryBackward,
  deleteLineBoundaryForward,
  deleteToLineEnd,
  deleteToLineStart,
  standardKeymap,
} from "@codemirror/commands";
import { deleteMarkupBackward } from "@codemirror/lang-markdown";
import { EditorView, keymap } from "@codemirror/view";
import type { Command } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { standaloneInsertionTokens } from "./standaloneInsertion";

interface Span {
  from: number;
  to: number;
}

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

/**
 * The hidden CriticMarkup between `from` and `to`: every delimiter, and every
 * comment whole (it shows as a marker and has no editable interior). Adjacent
 * pieces merge into one span, so the caret can never rest between a highlight's
 * `==}` and its comment, where typing would detach the comment.
 */
export function hiddenCriticSpans(state: EditorState, from: number, to: number): Span[] {
  const spans: Span[] = [];
  const standalone = new Set(standaloneInsertionTokens(state).map((token) => token.from));
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      // A standalone insertion is one block widget, atomic on its own.
      if (node.name === "CMInsert" && standalone.has(node.from)) return false;
      if (node.name === "CMComment" || HIDDEN_DELIM_NODES.has(node.name)) {
        const last = spans[spans.length - 1];
        if (last && node.from <= last.to) last.to = Math.max(last.to, node.to);
        else spans.push({ from: node.from, to: node.to });
        return false;
      }
      return;
    },
  });
  return spans;
}

/** The far edge of the hidden run touching `pos` on the deleting side, or `pos`. */
function hopHidden(state: EditorState, pos: number, forward: boolean): number {
  // A lookup around `pos` sees only the pieces near it, so a long run (a
  // comment, then the `==}` merged in front of it) takes more than one step.
  for (;;) {
    const span = hiddenCriticSpans(state, Math.max(0, pos - 1), Math.min(state.doc.length, pos + 1)).find(
      (s) => (forward ? s.from <= pos && pos < s.to : s.from < pos && pos <= s.to),
    );
    if (!span) return pos;
    pos = forward ? span.to : span.from;
  }
}

interface DeleteKind {
  /** Which way to hop over the hidden run at the caret before deleting. */
  hopForward: boolean;
  /** Leave the caret where it was (Delete) rather than where the deletion was. */
  keepCaret: boolean;
}

/**
 * Run a CodeMirror delete command as if the caret stood on the far side of the
 * hidden run it touches. The command sees a stand-in view (the real view's
 * prototype, a state with the hopped selection, a dispatch that captures), so
 * it keeps its own unit logic and atomic-range handling; its changes, which
 * refer to the same document, are then dispatched once on the real view.
 */
function overHidden(command: Command, kind: DeleteKind): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly || state.selection.ranges.length !== 1) return false;
    const main = state.selection.main;
    if (!main.empty) return false;
    const hopped = hopHidden(state, main.head, kind.hopForward);
    if (hopped === main.head) return false;

    let captured: Transaction | null = null;
    const stand = Object.create(view, {
      state: { value: state.update({ selection: EditorSelection.cursor(hopped) }).state },
      dispatch: { value: (tr: Transaction) => (captured = tr) },
    }) as EditorView;
    command(stand);
    // Nothing beyond the run (start or end of the document): consume the key
    // so the default command cannot delete the hidden markup instead.
    const tr = captured as Transaction | null;
    if (!tr) return true;
    view.dispatch({
      changes: tr.changes,
      selection: kind.keepCaret ? EditorSelection.cursor(tr.changes.mapPos(main.head, -1)) : tr.selection,
      userEvent: tr.annotation(Transaction.userEvent),
      scrollIntoView: true,
    });
    return true;
  };
}

// At the start of a list item or quote whose text opens with hidden markup,
// Backspace removes the list or quote marker, as markdown() does elsewhere.
const backspace: Command = (view) => deleteMarkupBackward(view) || deleteCharBackward(view);

const DELETES = new Map<Command, [Command, DeleteKind]>([
  [deleteCharBackward, [backspace, { hopForward: false, keepCaret: false }]],
  [deleteCharForward, [deleteCharForward, { hopForward: true, keepCaret: true }]],
  [deleteGroupBackward, [deleteGroupBackward, { hopForward: false, keepCaret: false }]],
  [deleteGroupForward, [deleteGroupForward, { hopForward: true, keepCaret: true }]],
  // A line delete takes everything visible up to the line edge, so it hops the
  // OTHER way: the run at the caret goes with the line, and a caret on either
  // side of a hidden `{==` deletes the same thing.
  [deleteLineBoundaryBackward, [deleteLineBoundaryBackward, { hopForward: true, keepCaret: false }]],
  [deleteLineBoundaryForward, [deleteLineBoundaryForward, { hopForward: false, keepCaret: false }]],
  [deleteToLineStart, [deleteToLineStart, { hopForward: true, keepCaret: false }]],
  [deleteToLineEnd, [deleteToLineEnd, { hopForward: false, keepCaret: false }]],
]);

// Every delete binding CodeMirror ships (Backspace, Delete, the word and line
// variants, the macOS Ctrl-H / Ctrl-D / Ctrl-K aliases), wrapped. Highest
// precedence: markdown()'s own Backspace binding sits at Prec.high.
const criticDeleteKeymap = Prec.highest(
  keymap.of(
    standardKeymap.flatMap((binding) => {
      const entry = binding.run ? DELETES.get(binding.run) : undefined;
      if (!entry) return [];
      const run = overHidden(...entry);
      return [{ ...binding, run, shift: binding.shift === binding.run ? run : binding.shift }];
    }),
  ),
);

// ── The guard ─────────────────────────────────────────────────────────────────

const CONSTRUCT_NODES = new Set(["CMInsert", "CMDelete", "CMSubstitute", "CMHighlight", "CMComment"]);
// "input" covers typing, paste, drop and Enter over a selection.
const GUARDED_EVENTS = ["delete", "input", "move.drop"];

interface Construct {
  /** The construct itself: `{==word==}`, `{++text++}`, `{>>note<<}`… */
  node: Span;
  /** Everything that goes with it: a highlight's trailing comments included. */
  unit: Span;
  /** Delimiters (a comment counts as one piece: it is all markup). */
  delims: Span[];
  /** A highlight's comments, kept with it when its word is partly edited. */
  comments: Span[];
  /** The visible text between the delimiters (two parts for a substitution). */
  inner: Span[];
}

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) out.push(child);
  return out;
}

function constructOf(node: SyntaxNode): Construct | null {
  const span = (n: SyntaxNode): Span => ({ from: n.from, to: n.to });
  const self = span(node);
  if (node.name === "CMComment") return { node: self, unit: self, delims: [self], comments: [], inner: [] };
  const delims = children(node).filter((child) => HIDDEN_DELIM_NODES.has(child.name));
  // A highlight nests: its own marks are its first and last children.
  const own = node.name === "CMHighlight" ? [delims[0], delims[delims.length - 1]] : delims;
  if (own.length < 2 || !own[0] || !own[own.length - 1]) return null;
  const inner: Span[] = [];
  for (let i = 0; i + 1 < own.length; i++) inner.push({ from: own[i]!.to, to: own[i + 1]!.from });
  const comments: Span[] = [];
  if (node.name === "CMHighlight") {
    let end = node.to;
    for (let next = node.nextSibling; next?.name === "CMComment" && next.from === end; next = next.nextSibling) {
      comments.push(span(next));
      end = next.to;
    }
  }
  const unitTo = comments.length ? comments[comments.length - 1]!.to : node.to;
  return { node: self, unit: { from: node.from, to: unitTo }, delims: own.map((d) => span(d!)), comments, inner };
}

const overlaps = (a: Span, b: Span) => a.from < b.to && b.from < a.to;
const contains = (outer: Span, inner: Span) => outer.from <= inner.from && inner.to <= outer.to;

function subtract(range: Span, holes: Span[]): Span[] {
  let pieces: Span[] = [range];
  for (const hole of holes) {
    pieces = pieces.flatMap((p) => {
      if (!overlaps(p, hole)) return [p];
      const out: Span[] = [];
      if (p.from < hole.from) out.push({ from: p.from, to: hole.from });
      if (hole.to < p.to) out.push({ from: hole.to, to: p.to });
      return out;
    });
  }
  return pieces.filter((p) => p.to > p.from);
}

/**
 * What deleting `deletions` (typing at `inserts`) really removes once no
 * construct may lose part of its markup: `removed` is the visible text taken,
 * `cleanup` the delimiters of constructs left empty.
 */
function planEdit(state: EditorState, deletions: Span[], inserts: number[]): { removed: Span[]; cleanup: Span[] } {
  const constructs = new Map<string, Construct>();
  const tree = syntaxTree(state);
  for (const del of deletions) {
    tree.iterate({
      from: del.from,
      to: del.to,
      enter: (ref) => {
        if (!CONSTRUCT_NODES.has(ref.name) || !overlaps(ref, del)) return;
        const construct = constructOf(ref.node);
        if (construct) constructs.set(`${construct.node.from}:${construct.node.to}`, construct);
      },
    });
  }

  // A construct is cut when an edit reaches into it without taking all of it
  // (for a highlight: the highlight plus its comments). A cut construct keeps
  // its delimiters; a highlight keeps its comments too when the edit touches its
  // word, so a selection over only the marker still deletes the comment.
  const cut = [...constructs.values()].filter((c) =>
    deletions.some((d) => overlaps(d, c.node)) && !deletions.some((d) => contains(d, c.unit)),
  );
  const touchesText = (c: Construct) => deletions.some((d) => c.inner.some((part) => overlaps(d, part)));
  const keep = cut.flatMap((c) => (touchesText(c) ? [...c.delims, ...c.comments] : c.delims));
  const removed = deletions.flatMap((d) => subtract(d, keep));

  // A cut construct left with no visible text, and nothing typed into it, goes
  // too; comments inside or after it stay, as point comments. Innermost first,
  // so an outer highlight whose only content was an emptied one goes as well.
  const commentsIn = (part: Span): Span[] => {
    const found: Span[] = [];
    tree.iterate({
      from: part.from,
      to: part.to,
      enter: (ref) => {
        if (ref.name === "CMComment" && contains(part, ref)) found.push({ from: ref.from, to: ref.to });
      },
    });
    return found;
  };
  const gone = [...removed];
  const cleanup: Span[] = [];
  for (const c of [...cut].sort((a, b) => a.node.to - a.node.from - (b.node.to - b.node.from))) {
    if (!c.inner.length) continue;
    if (inserts.some((pos) => c.inner.some((part) => part.from <= pos && pos <= part.to))) continue;
    if (c.inner.every((part) => subtract(part, [...gone, ...commentsIn(part)]).length === 0)) {
      gone.push(...c.delims);
      cleanup.push(...c.delims);
    }
  }
  return { removed, cleanup };
}

/**
 * Rewrite a user edit so it never removes part of a construct. Returns null
 * when the edit already respects every construct it touches.
 */
export function guardCriticEdit(tr: Transaction): TransactionSpec | null {
  if (!tr.docChanged || !GUARDED_EVENTS.some((event) => tr.isUserEvent(event))) return null;
  const start = tr.startState;
  if (start.selection.ranges.length !== 1) return null;

  const edits: Array<{ del: Span; insert: string }> = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    edits.push({ del: { from: fromA, to: toA }, insert: inserted.toString() });
  });
  const deletions = edits.map((e) => e.del).filter((d) => d.to > d.from);
  if (!deletions.length) return null;
  const inserted = edits.filter((e) => e.insert).map((e) => ({ from: e.del.from, insert: e.insert }));
  const { removed, cleanup } = planEdit(start, deletions, inserted.map((e) => e.from));

  const changedShape = removed.length !== deletions.length ||
    removed.some((r, i) => r.from !== deletions[i]!.from || r.to !== deletions[i]!.to);
  if (!changedShape && !cleanup.length) return null;

  const changes: ChangeSpec[] = [...[...removed, ...cleanup].map((r) => ({ from: r.from, to: r.to })), ...inserted];
  const changeSet = start.changes(changes);
  let selection: EditorSelection;
  const drop = tr.isUserEvent("move.drop") ? inserted[0] : undefined;
  if (drop) {
    // The dropped text ends up selected, as CodeMirror leaves it.
    const at = changeSet.mapPos(drop.from, -1);
    selection = EditorSelection.single(at, at + drop.insert.length);
  } else {
    // The caret ends where the edit began, after anything typed there.
    const caret = Math.min(start.selection.main.from, ...edits.map((e) => e.del.from));
    const typed = edits.find((e) => e.insert && e.del.from === caret)?.insert.length ?? 0;
    selection = EditorSelection.single(typed ? changeSet.mapPos(caret, -1) + typed : changeSet.mapPos(caret, 1));
  }
  return {
    changes: changeSet,
    selection,
    effects: tr.effects,
    userEvent: tr.annotation(Transaction.userEvent),
    scrollIntoView: tr.scrollIntoView,
  };
}

const criticEditGuard = EditorState.transactionFilter.of((tr) => guardCriticEdit(tr) ?? tr);

// Copy, cut and drag of a selection carry what a cut would remove: the visible
// text, plus any construct the selection covers whole.
const criticClipboardFilter = EditorView.clipboardOutputFilter.of((text, state) => {
  const { main } = state.selection;
  if (state.selection.ranges.length !== 1 || main.empty || state.sliceDoc(main.from, main.to) !== text) return text;
  const { removed } = planEdit(state, [{ from: main.from, to: main.to }], []);
  return removed.map((r) => state.sliceDoc(r.from, r.to)).join("");
});

/** Keymap, guard and clipboard filter; rich view only, so source mode edits raw text. */
export function criticEditing(): Extension {
  return [criticDeleteKeymap, criticEditGuard, criticClipboardFilter];
}
