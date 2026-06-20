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

import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import type { NSpell } from "nspell";
import type { SpellVariant } from "../lib/viewSettings";

// ── Engine singleton ──────────────────────────────────────────────────────────

let speller: NSpell | null = null;
let loading = false;
// Active spelling variant (UK/US). App mirrors the persisted setting into this via
// setSpellVariant; "uk" matches DEFAULT_SETTINGS so the first build is British.
let variant: SpellVariant = "uk";

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

/** Dynamic-import the raw .aff/.dic for a variant. Each variant's dictionary is
 *  inlined at build time by the Vite plugin (vite.config.ts) — the deps are the
 *  source of truth, the files are NOT committed — and lands in its own lazy chunk;
 *  the offline binary embeds them, so there's no runtime fetch. */
function loadDict(v: SpellVariant): Promise<[string, string]> {
  return v === "us"
    ? Promise.all([
        import("virtual:dict-en/aff").then((m) => m.default),
        import("virtual:dict-en/dic").then((m) => m.default),
      ])
    : Promise.all([
        import("virtual:dict-en-gb/aff").then((m) => m.default),
        import("virtual:dict-en-gb/dic").then((m) => m.default),
      ]);
}

/** Kick off the dictionary load + speller build for the active variant (idempotent).
 *  Spell results are empty until this resolves; subscribers fire when it does. */
export function ensureSpeller(): void {
  if (speller || loading) return;
  loading = true;
  const target = variant; // snapshot — the variant may switch before this resolves
  void (async () => {
    try {
      const [nspell, [aff, dic], supplement] = await Promise.all([
        import("nspell").then((m) => m.default),
        loadDict(target),
        // Common words both SCOWL dictionaries miss (transformative, gameplay…).
        import("./spell-supplement").then((m) => m.SPELL_SUPPLEMENT),
      ]);
      const s = nspell(aff, dic);
      for (const w of supplement) s.add(w); // fill the coverage gaps
      for (const w of customWords) s.add(w); // re-apply the personal dictionary
      if (target === variant) speller = s; // ignore a build for a now-stale variant
    } finally {
      loading = false;
      // If the variant switched mid-load, the build above was discarded — kick off
      // a fresh one for the variant that's now active.
      if (variant !== target && !speller) ensureSpeller();
      notify();
    }
  })();
}

/** Switch spelling dictionaries (UK ⇄ US). Drops the current engine and rebuilds;
 *  the view plugin repaints via notify(), clearing underlines until it's ready. */
export function setSpellVariant(v: SpellVariant): void {
  if (v === variant) return;
  variant = v;
  speller = null;
  ensureSpeller();
  notify();
}

/** Replace the personal dictionary (App calls this when the persisted list loads
 *  or changes). Lowercased; mirrored into the live speller. */
export function setCustomWords(words: Iterable<string>): void {
  const next = new Set<string>();
  for (const w of words) next.add(w.toLowerCase());
  let needsRebuild = false;
  if (speller) {
    // A removal is the tricky case: nspell.remove() deletes the word from the
    // WHOLE engine, base dictionary included — so de-adding a word the active
    // base dict (or supplement) ALSO provides un-teaches it until the next
    // rebuild (add `color` in UK mode, switch to US, then de-add it → US loses
    // `color`). Rather than guess which words the base dict owns, rebuild from
    // scratch whenever anything was removed; removals are rare (a user de-adding
    // a word), so the brief underline-clear during the async rebuild is fine.
    let removed = false;
    for (const w of customWords) if (!next.has(w)) { removed = true; break; }
    if (removed) {
      speller = null;
      needsRebuild = true;
    } else {
      // Pure additions: mirror them in incrementally so we don't re-add the
      // whole list every keystroke.
      for (const w of next) if (!customWords.has(w)) speller.add(w);
    }
  }
  customWords.clear();
  for (const w of next) customWords.add(w);
  // Only rebuild the live engine we just invalidated. When speller is already
  // null because spellcheck hasn't started yet, leave it lazy — the next enable/
  // load will apply the updated customWords; don't eagerly build from a sync.
  if (needsRebuild) ensureSpeller();
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

// ── Whole-document review (for the Spelling-review modal) ─────────────────────
// The right-click handler and the underline only look at the viewport; the review
// needs EVERY flagged word in the document, deduplicated. It reuses the exact same
// tokenizer + skip rules so the review and the squiggles always agree — and forces
// a full parse first (the syntax tree is otherwise lazy past the viewport, which
// would leave code/URL/comment skip-regions unparsed and mis-flag their contents).

export interface FlaggedWord {
  /** A representative surface form (the first occurrence's exact text). */
  word: string;
  /** Lowercased dedup key. */
  lower: string;
  /** How many flagged occurrences in the document. */
  count: number;
  /** Offset of the first occurrence — the document-order sort key. */
  from: number;
}

/** Force the syntax tree to cover the whole document, so skip-region detection is
 *  correct past the viewport. Falls back to the partial tree if parsing times out. */
function ensureParsed(view: EditorView): void {
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
}

/** Every flagged (misspelled, not custom/ignored) word in the document, deduped
 *  case-insensitively, in document order (first appearance). Empty before load. */
export function collectFlagged(view: EditorView): FlaggedWord[] {
  if (!speller) return [];
  ensureParsed(view);
  const text = view.state.doc.toString();
  const skip = collectSkipRanges(view, 0, text.length);
  const re = wordRe();
  const seen = new Map<string, FlaggedWord>(); // insertion order == document order
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const word = m[0];
    if (word.length < MIN_LEN) continue;
    const from = m.index;
    if (overlapsSkip(skip, from, from + word.length)) continue;
    if (!isMisspelledWord(word)) continue;
    const hit = seen.get(word.toLowerCase());
    if (hit) hit.count++;
    else seen.set(word.toLowerCase(), { word, lower: word.toLowerCase(), count: 1, from });
  }
  return [...seen.values()];
}

/** Re-case `word` to match the shape of `sample`: UPPER → all caps, Titlecase →
 *  capitalised, anything else → left as-is. Keeps a sentence-start "Recieve" →
 *  "Receive" while a mid-sentence "recieve" → "receive". */
function matchCase(sample: string, word: string): string {
  if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return word.toUpperCase();
  if (sample[0] === sample[0].toUpperCase() && sample[0] !== sample[0].toLowerCase())
    return word[0].toUpperCase() + word.slice(1);
  return word;
}

/** Edits that replace EVERY flagged occurrence of `lower` with `replacement`,
 *  preserving each occurrence's case. Whole-word, skip-aware, and re-checks each
 *  occurrence against the engine — so a correctly-cased homograph that shares the
 *  lemma (e.g. a proper-noun "Polish" vs the flagged "polish") is left untouched.
 *  Returned in ascending order, ready for a single `view.dispatch({ changes })`. */
export function fixAllEdits(
  view: EditorView,
  lower: string,
  replacement: string,
): { from: number; to: number; insert: string }[] {
  if (!speller) return [];
  ensureParsed(view);
  const text = view.state.doc.toString();
  const skip = collectSkipRanges(view, 0, text.length);
  const re = wordRe();
  const edits: { from: number; to: number; insert: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const word = m[0];
    if (word.length < MIN_LEN || word.toLowerCase() !== lower) continue;
    const from = m.index;
    if (overlapsSkip(skip, from, from + word.length)) continue;
    if (!isMisspelledWord(word)) continue;
    edits.push({ from, to: from + word.length, insert: matchCase(word, replacement) });
  }
  return edits;
}
