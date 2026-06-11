// ── Markdown live-preview ─────────────────────────────────────────────────────
// Makes the buffer LOOK rendered while staying plain text. Two responsibilities,
// split into two ViewPlugins (each with its OWN RangeSetBuilder) because a mark
// and a replace over the SAME node range overlap and crash a single builder:
//
//   1. STYLE plugin  — Decoration.mark to size headings, embolden strong, etc.,
//      plus a line decoration giving blockquote lines a left rule.
//   2. HIDE plugin    — Decoration.replace (empty) to hide the syntax markers
//      (#, **, _, `, >, list bullets, link [] () ) UNLESS the cursor/selection is
//      on that line, in which case the markers are revealed for editing.
//
// Both only walk `view.visibleRanges` and rebuild on doc / viewport / selection
// changes. CriticMarkup nodes are skipped entirely — criticMarkupView.ts owns
// those. Every builder receives ranges in increasing `from` order (syntaxTree's
// enter() is pre-order left-to-right, which already satisfies this for the marks;
// the hide plugin sorts defensively where mixed sources could interleave).

import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension, Range } from "@codemirror/state";

// CriticMarkup delimiter nodes we hide (like Markdown markers) so suggestions read
// as rendered prose: green inserted text, struck deletions, etc. — not raw `{++…++}`.
// Comment markup is NOT here: criticMarkupView.ts replaces the whole `{>>…<<}` with a
// 💬 bubble. Revealed on the active line for editing, same as Markdown markers.
const CM_DELIM_NODES = new Set<string>([
  "CMInsertOpen",
  "CMInsertClose",
  "CMDeleteOpen",
  "CMDeleteClose",
  // Highlight delimiters are now a single (nesting-aware) mark node — see
  // criticMarkupParser.ts. Hiding it covers clean, stacked, and ins/del-content
  // highlights uniformly (no more raw `{==`/`==}` leak).
  "CMHighlightMark",
  "CMSubOpen",
  "CMSubClose",
]);

/** Renders the substitution `~>` as a tidy arrow when the line isn't active. */
class SubArrowWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-sub-arrow";
    s.textContent = "→";
    return s;
  }
}
const subArrowDeco = Decoration.replace({ widget: new SubArrowWidget() });

/** Renders a real bullet in place of a `-`/`*`/`+` list marker (off the active line),
 *  so unordered lists read as lists, not flat paragraphs. */
class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-bullet";
    s.textContent = "•";
    return s;
  }
}
const bulletDeco = Decoration.replace({ widget: new BulletWidget() });

// Marks that, when present as a node's child, denote raw markdown syntax we hide.
// NB: ListMark is NOT here — it's special-cased in buildHide (rendered as a bullet
// for unordered lists, left visible for ordered) rather than hidden outright.
const HIDDEN_MARK_NODES = new Set<string>([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "QuoteMark",
  "LinkMark", // the [, ], (, ) brackets and url delimiters
  "URL", // bare url text inside ( ) — hide so only link text shows
  // NB: fenced-code nodes (CodeInfo/CodeText/CodeMark fences) are intentionally
  // NOT hidden — hiding CodeText would make code blocks vanish. Inline code keeps
  // its backticks hidden via CodeMark above.
]);

// Container nodes whose presence we style with a mark class.
function headingClass(name: string): string | null {
  switch (name) {
    case "ATXHeading1":
    case "SetextHeading1":
      return "cm-md-h1";
    case "ATXHeading2":
    case "SetextHeading2":
      return "cm-md-h2";
    case "ATXHeading3":
      return "cm-md-h3";
    case "ATXHeading4":
      return "cm-md-h4";
    case "ATXHeading5":
      return "cm-md-h5";
    case "ATXHeading6":
      return "cm-md-h6";
    default:
      return null;
  }
}

function inlineMarkClass(name: string): string | null {
  switch (name) {
    case "StrongEmphasis":
      return "cm-md-strong";
    case "Emphasis":
      return "cm-md-em";
    case "InlineCode":
      return "cm-md-code";
    case "Link":
      return "cm-md-link";
    case "Blockquote":
      return "cm-md-quote";
    // ListItem text stays normal colour — the bullet (rendered in buildHide) carries
    // the "this is a list" signal, not a muted body.
    default:
      return null;
  }
}

/** True when the editor is focused AND a selection range touches the line
 *  containing [from,to). Gated on focus so an unfocused document renders fully
 *  (no stray markers revealed by the default cursor-at-0). */
function selectionOnRange(view: EditorView, from: number, to: number): boolean {
  if (!view.hasFocus) return false;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  for (const r of view.state.selection.ranges) {
    if (r.to >= startLine.from && r.from <= endLine.to) return true;
  }
  return false;
}

const hiddenMark = Decoration.replace({});

// ── STYLE plugin ──────────────────────────────────────────────────────────────
function buildStyle(view: EditorView): DecorationSet {
  // Collect ranges then sort by (from, startSide) so the builder never receives
  // out-of-order input — heading marks and inline marks can interleave.
  const ranges: Range<Decoration>[] = [];
  const quoteLineClass = Decoration.line({ class: "cm-md-quote-line" });

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: vFrom,
      to: vTo,
      enter: (node) => {
        const name = node.name;
        // Don't descend into CriticMarkup — its view owns styling there.
        if (name.startsWith("CM")) return false;

        const hClass = headingClass(name);
        if (hClass) {
          ranges.push(Decoration.mark({ class: hClass }).range(node.from, node.to));
          return;
        }
        const iClass = inlineMarkClass(name);
        if (iClass && node.to > node.from) {
          ranges.push(Decoration.mark({ class: iClass }).range(node.from, node.to));
        }
        if (name === "Blockquote") {
          // Apply a left-rule line decoration to each line the quote spans.
          let pos = node.from;
          while (pos <= node.to) {
            const line = view.state.doc.lineAt(pos);
            ranges.push(quoteLineClass.range(line.from));
            if (line.to + 1 > node.to) break;
            pos = line.to + 1;
          }
        }
      },
    });
  }

  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

const styleViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildStyle(view);
    }
    update(u: ViewUpdate) {
      // syntaxTree check: the parse is async on large docs — rebuild when the
      // tree extends, or styling freezes at the first-paint parse boundary.
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.state) !== syntaxTree(u.startState)) {
        this.decorations = buildStyle(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ── HIDE plugin ─────────────────────────────────────────────────────────────
function buildHide(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: vFrom,
      to: vTo,
      enter: (node) => {
        const name = node.name;
        // CriticMarkup stays rendered ALWAYS — its delimiters never reveal on the
        // active line (you interact via the dot/✓/✗ controls, not the raw braces),
        // so clicking a line keeps the WYSIWYG view. Comment markup is replaced
        // wholesale by criticMarkupView; here we just hide suggestion/highlight
        // delimiters and render the substitution `~>` as →.
        if (name === "CMComment") return false;
        if (name === "CMSubArrow") {
          ranges.push(subArrowDeco.range(node.from, node.to));
          return false;
        }
        if (CM_DELIM_NODES.has(name)) {
          if (node.from !== node.to) ranges.push(hiddenMark.range(node.from, node.to));
          return false;
        }
        if (name.startsWith("CM")) return; // container node — descend to its delimiters

        // List markers: render a bullet for unordered (-, *, +); leave ordered (1.)
        // visible. Revealed raw on the active line for editing. (Not in HIDDEN_MARK_NODES.)
        if (name === "ListMark") {
          if (node.from === node.to) return;
          if (selectionOnRange(view, node.from, node.to)) return;
          const mark = view.state.doc.sliceString(node.from, node.to);
          if (/^[-*+]$/.test(mark)) ranges.push(bulletDeco.range(node.from, node.to));
          return;
        }

        if (!HIDDEN_MARK_NODES.has(name)) return;
        if (node.from === node.to) return;
        // Only hide a URL when it's the target of an inline [text](url) link; a
        // bare/autolink URL in prose must stay visible (GFM emits a top-level URL
        // node for those too).
        if (name === "URL" && node.node.parent?.name !== "Link") return;
        // Reveal markers on the active line so they can be edited.
        if (selectionOnRange(view, node.from, node.to)) return;
        if (name === "HeaderMark") {
          // Also hide the single space after `#`/`##` so the heading text renders
          // flush — otherwise the hidden marker leaves a leading space (looks like
          // the line isn't really a heading).
          const to =
            view.state.doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
          ranges.push(hiddenMark.range(node.from, to));
          return;
        }
        ranges.push(hiddenMark.range(node.from, node.to));
      },
    });
  }

  ranges.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

const hideViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHide(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
        this.decorations = buildHide(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    // Replace decorations that hide content must be provided as decorations the
    // view treats specially; supplying via the plugin's `decorations` is fine for
    // replace marks (they participate in the standard decoration set).
  },
);

/** The live-preview extension: style marks + marker-hiding, as two plugins. */
export const markdownPreview: Extension = [styleViewPlugin, hideViewPlugin];
