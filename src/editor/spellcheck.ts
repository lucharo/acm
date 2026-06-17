// ── Spell checking ────────────────────────────────────────────────────────────
// A Google-Docs-style spellchecker for the prose buffer: a wiggly red underline
// under misspelled words, with a right-click menu (App owns the menu) to replace
// the word, add it to a personal dictionary, or ignore it for the session.
//
// Engine: nspell over the bundled `dictionary-en` Hunspell files. The dictionary
// (~540KB) is loaded LAZILY via dynamic `?raw` import the first time spell check
// is switched on, so it never costs anything when the feature is off, and lands in
// its own bundle chunk. Building the speller is ~50ms (measured), done once.
//
// State lives at MODULE scope (a singleton) because two consumers share it: the
// CodeMirror decoration plugin below, and App's right-click handler (suggestions /
// add / ignore). The custom dictionary is the user's persisted word list; the
// ignore set is session-only ("Ignore" = stop flagging this word until reload),
// matching how desktop editors treat Ignore vs Add.
//
// Pure decoration — like bionicView, the buffer/.md on disk is never touched.

import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import type { NSpell } from "nspell";

// ── Engine singleton ──────────────────────────────────────────────────────────

let speller: NSpell | null = null;
let loading = false;

// The user's personal dictionary (lowercased), persisted by App via useDictionary.
// Mirrored into the speller (via .add) so both `correct` and `suggest` honour it.
const customWords = new Set<string>();
// Session-only "ignore this word" set (lowercased) — cleared on reload, like the
// Ignore action in Word/Pages. Never persisted.
const ignoredWords = new Set<string>();

// Listeners notified when something that affects results changes: the engine
// finishing its load, or the custom/ignore sets mutating. The view plugin
// subscribes so it can repaint; App could too. Kept as a Set so multiple editors
// (and future consumers) all refresh.
const listeners = new Set<() => void>();
function notify() {
  for (const cb of listeners) cb();
}

/** Subscribe to "results may have changed" events. Returns an unsubscribe fn. */
export function subscribeSpell(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Kick off the one-time dictionary load + speller build (idempotent). Spell
 *  results are empty until this resolves; subscribers fire when it does. */
export function ensureSpeller(): void {
  if (speller || loading) return;
  loading = true;
  void (async () => {
    try {
      const [nspell, aff, dic] = await Promise.all([
        import("nspell").then((m) => m.default),
        // Raw dictionary strings, inlined at build time from the `dictionary-en` dep
        // by the Vite plugin in vite.config.ts (the dep is the source of truth — the
        // files are NOT committed). Lands in its own lazy chunk; the offline binary
        // embeds it — no runtime fetch.
        import("virtual:dict-en/aff").then((m) => m.default),
        import("virtual:dict-en/dic").then((m) => m.default),
      ]);
      const s = nspell(aff, dic);
      for (const w of customWords) s.add(w); // re-apply the personal dictionary
      speller = s;
    } finally {
      loading = false;
      notify();
    }
  })();
}

/** Replace the personal dictionary (App calls this when the persisted list loads
 *  or changes). Lowercased; mirrored into the live speller. */
export function setCustomWords(words: Iterable<string>): void {
  const next = new Set<string>();
  for (const w of words) next.add(w.toLowerCase());
  // Diff against the speller so we don't re-add the whole list every keystroke.
  if (speller) {
    for (const w of next) if (!customWords.has(w)) speller.add(w);
    for (const w of customWords) if (!next.has(w)) speller.remove(w);
  }
  customWords.clear();
  for (const w of next) customWords.add(w);
  notify();
}

/** Stop flagging `word` for the rest of this session (the "Ignore" action). */
export function ignoreWord(word: string): void {
  ignoredWords.add(word.trim().toLowerCase());
  notify();
}

// ── Word model ──────────────────────────────────────────────────────────────
// A spellable "word" is a run of Latin letters with optional internal apostrophes
// (don't, John's). Restricting to the Latin script means non-English text (CJK,
// Cyrillic, Greek…) is left alone rather than flagged wholesale and given garbage
// suggestions. Hyphens are word boundaries, so "well-known" checks as "well" +
// "known" (the Hunspell dict has neither hyphenated compound) and digit-bearing
// tokens (v2, h2o, sha256) split into sub-runs we then drop by the length floor.
// Fresh per call site: a `/g` regex carries mutable `lastIndex`, so a single
// shared instance is a footgun if two scans ever interleave. The factory keeps
// the pattern in one place without the shared state.
const wordRe = () => /\p{Script=Latin}(?:[\p{Script=Latin}'’]*\p{Script=Latin})?/gu;
// Below this length a "word" is almost always an abbreviation/initial (a, ok, mr)
// or a digit-token fragment — too noisy to flag, and the dictionary's coverage of
// 1–2 letter tokens is poor. Matches the conservative floor desktop editors use.
const MIN_LEN = 3;

/** Is this (already-tokenised) word misspelled? Custom dictionary + session
 *  ignore set win; otherwise defer to the engine. Safe before load (→ false). */
function isMisspelledWord(word: string): boolean {
  if (!speller || word.length < MIN_LEN) return false;
  const lower = word.toLowerCase();
  if (customWords.has(lower) || ignoredWords.has(lower)) return false;
  return !speller.correct(word);
}

/** Correction candidates for `word` (empty before load or when none). Capped —
 *  nspell.suggest can take ~100ms for a word with no near neighbours, which is
 *  fine for a right-click but we don't need a long list. */
export function suggestFor(word: string): string[] {
  if (!speller) return [];
  return speller.suggest(word).slice(0, 6);
}

// ── Skip regions (code / links / hidden comment markup) ───────────────────────
// Prose inside tracked-change markup ({++…++} etc.) IS real prose and gets
// checked — only the delimiters are punctuation the word regex skips anyway. But
// code spans, URLs, and the hidden comment body are not prose: collect their
// ranges per repaint (one syntax-tree walk over the viewport, same as the other
// view layers) and drop any word overlapping them.
const SKIP_NODES = new Set<string>([
  "InlineCode",
  "FencedCode",
  "CodeBlock", // indented code
  "CodeText",
  "URL",
  "CMComment", // {>>…<<} — hidden behind the 💬 dot, never prose to check
]);

interface Span {
  from: number;
  to: number;
}

function collectSkipRanges(view: EditorView, from: number, to: number): Span[] {
  const out: Span[] = [];
  syntaxTree(view.state).iterate({
    from,
    to,
    enter: (node) => {
      if (SKIP_NODES.has(node.name)) {
        out.push({ from: node.from, to: node.to });
        return false; // whole region is excluded — no need to descend
      }
      return undefined;
    },
  });
  return out;
}

/** True if [from,to) overlaps any skip span. `spans` is in ascending order
 *  (syntaxTree enter() is pre-order left-to-right). */
function overlapsSkip(spans: Span[], from: number, to: number): boolean {
  for (const s of spans) {
    if (s.from >= to) break; // spans sorted by `from`; no later one can overlap
    if (s.to > from) return true;
  }
  return false;
}

// ── Decoration plugin ─────────────────────────────────────────────────────────

const errorMark = Decoration.mark({ class: "cm-spell-error" });

/** Bumped to force the plugin to repaint when engine/dictionary state changes
 *  (load finishing, a word added/ignored) — none of which is a doc/view event. */
const bumpSpell = StateEffect.define<null>();

function buildSpellDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (!speller) return builder.finish();
  for (const { from, to } of view.visibleRanges) {
    const skip = collectSkipRanges(view, from, to);
    const text = view.state.sliceDoc(from, to);
    const re = wordRe();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const word = m[0];
      if (word.length < MIN_LEN) continue;
      const wFrom = from + m.index;
      const wTo = wFrom + word.length;
      if (overlapsSkip(skip, wFrom, wTo)) continue;
      if (isMisspelledWord(word)) builder.add(wFrom, wTo, errorMark);
    }
  }
  return builder.finish();
}

const spellPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private unsub: () => void;
    constructor(view: EditorView) {
      ensureSpeller(); // begin loading the moment spell check is switched on
      this.decorations = buildSpellDecorations(view);
      // Repaint when the engine loads or the dictionary/ignore set changes.
      // Dispatching from outside the update cycle is safe (load resolves off an
      // async tick; dict edits come from React event handlers).
      this.unsub = subscribeSpell(() => {
        view.dispatch({ effects: bumpSpell.of(null) });
      });
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        // Async parse can extend the tree with no doc/view change (see the other
        // view layers) — rebuild so skip-regions stay correct past first paint.
        syntaxTree(u.state) !== syntaxTree(u.startState) ||
        u.transactions.some((t) => t.effects.some((e) => e.is(bumpSpell)))
      ) {
        this.decorations = buildSpellDecorations(u.view);
      }
    }
    destroy() {
      this.unsub();
    }
  },
  { decorations: (v) => v.decorations },
);

export const spellcheck: Extension = spellPlugin;

// ── Word-at-point (for App's right-click menu) ────────────────────────────────

export interface SpellHit {
  from: number;
  to: number;
  word: string;
  suggestions: string[];
}

/** If `pos` falls on a misspelled, checkable word, return its range + word +
 *  suggestions; else null. Uses the SAME tokenizer/skip rules as the underline so
 *  the menu and the squiggle always agree. */
export function misspelledWordAt(view: EditorView, pos: number): SpellHit | null {
  if (!speller) return null;
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const rel = pos - line.from;
  const re = wordRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    // Right-click typically lands just before/inside the word; accept a hit when
    // pos is anywhere in [start, end].
    if (rel < start) break; // matches are left-to-right; gone past the click
    if (rel > end) continue;
    const word = m[0];
    if (word.length < MIN_LEN) return null;
    const from = line.from + start;
    const to = line.from + end;
    if (overlapsSkip(collectSkipRanges(view, line.from, line.to), from, to)) return null;
    if (!isMisspelledWord(word)) return null;
    return { from, to, word, suggestions: suggestFor(word) };
  }
  return null;
}
