// ── Spell-check word model (shared, dependency-free) ──────────────────────────
// The pure pieces of the spellchecker: the tokenizer, the length floor, the set of
// syntax-tree node names whose contents are NOT prose, and the small geometry/case
// helpers. Lives here — with NO CodeMirror imports — so two very different consumers
// share ONE source of truth and can never drift:
//   • editor/spellcheck.ts (browser) — walks CodeMirror's `syntaxTree` for skip
//     regions and paints squiggles;
//   • cli/spellEngine.ts (Bun) — parses the raw .md with the same @lezer/markdown
//     grammar for skip regions and reports/fixes from the shell.
// Both use the SAME node names (they're Lezer names either way), the SAME word
// regex, and the SAME case rules, so `acm spell` and the on-screen underline always
// agree.

// A spellable "word" is a run of Latin letters with optional internal apostrophes
// (don't, John's). Restricting to the Latin script means non-English text (CJK,
// Cyrillic, Greek…) is left alone rather than flagged wholesale and given garbage
// suggestions. Hyphens are word boundaries, so "well-known" checks as "well" +
// "known" (the Hunspell dict has neither hyphenated compound) and digit-bearing
// tokens (v2, h2o, sha256) split into sub-runs we then drop by the length floor.
// Fresh per call site: a `/g` regex carries mutable `lastIndex`, so a single shared
// instance is a footgun if two scans ever interleave. The factory keeps the pattern
// in one place without the shared state.
export const wordRe = (): RegExp => /\p{Script=Latin}(?:[\p{Script=Latin}'’]*\p{Script=Latin})?/gu;

// Below this length a "word" is almost always an abbreviation/initial (a, ok, mr) or
// a digit-token fragment — too noisy to flag, and the dictionary's coverage of 1–2
// letter tokens is poor. Matches the conservative floor desktop editors use.
export const MIN_LEN = 3;

// Syntax-tree nodes whose contents are not prose: code spans, URLs, and the hidden
// comment body. Words overlapping any of these are dropped. The names are Lezer
// node names — identical whether walked via CodeMirror's `syntaxTree` (browser) or a
// raw `@lezer/markdown` parse (CLI). Prose inside tracked-change markup ({++…++}) IS
// checked; only CMComment ({>>…<<}, hidden behind the 💬 dot) is excluded here.
export const SKIP_NODES = new Set<string>([
  "InlineCode",
  "FencedCode",
  "CodeBlock", // indented code
  "CodeText",
  "URL",
  "CMComment",
]);

export interface Span {
  from: number;
  to: number;
}

/** True if [from,to) overlaps any skip span. `spans` MUST be in ascending `from`
 *  order (both producers iterate the tree pre-order left-to-right). */
export function overlapsSkip(spans: Span[], from: number, to: number): boolean {
  for (const s of spans) {
    if (s.from >= to) break; // spans sorted by `from`; no later one can overlap
    if (s.to > from) return true;
  }
  return false;
}

/** Re-case `word` to match the shape of `sample`: UPPER → all caps, Titlecase →
 *  capitalised, anything else → left as-is. Keeps a sentence-start "Recieve" →
 *  "Receive" while a mid-sentence "recieve" → "receive". */
export function matchCase(sample: string, word: string): string {
  if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return word.toUpperCase();
  if (sample[0] === sample[0].toUpperCase() && sample[0] !== sample[0].toLowerCase())
    return word[0].toUpperCase() + word.slice(1);
  return word;
}

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
