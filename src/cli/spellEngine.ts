// ── acm spell — the Bun-side spell engine ─────────────────────────────────────
// The browser checker (editor/spellcheck.ts) runs inside CodeMirror and can't be
// reached from the shell. This is the same engine, rebuilt for a one-shot CLI
// process: it loads nspell over the bundled Hunspell dictionaries, applies the
// supplement + the user's personal dictionary, and reports / fixes spelling on a
// raw .md string.
//
// PARITY is the whole point — `acm spell` must agree with the on-screen squiggles.
// It gets there by sharing the exact word model (lib/spellModel: tokenizer, length
// floor, skip-node names, case rule) and by parsing the doc with the SAME
// @lezer/markdown grammar the editor uses, so code spans / URLs / hidden comments
// are skipped identically. The only thing that differs from the browser is the
// syntax-tree WALK: a raw `parser.parse(text)` here vs. CodeMirror's `syntaxTree`.
//
// One-shot, so there are no live mutation sets: the supplement and personal words
// are `.add()`ed into the speller once at construction (an explicit lowercased
// personal set backs up nspell's own casing, exactly as the browser does).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import nspell from "nspell";
import type { NSpell } from "nspell";
import { parser as mdParser, GFM } from "@lezer/markdown";
import { CriticMarkup } from "../editor/criticMarkupParser";
import { SPELL_SUPPLEMENT } from "../editor/spell-supplement";
import { wordRe, MIN_LEN, SKIP_NODES, overlapsSkip, matchCase } from "../lib/spellModel";
import type { Span, FlaggedWord } from "../lib/spellModel";
import type { SpellVariant } from "../lib/viewSettings";

// Skip-region parser. The editor uses `markdown({ base: markdownLanguage, … })`,
// i.e. commonmark + GFM + Subscript/Superscript/Emoji + CriticMarkup. Of those, only
// GFM (Autolink → URL) and CriticMarkup (CMComment) add nodes in SKIP_NODES on top of
// commonmark; the rest can't change which ranges are code / URL / comment. So this
// pared-down config yields byte-identical skip regions.
const skipParser = mdParser.configure([GFM, CriticMarkup]);

export interface SpellEngine {
  /** Every flagged word in `text`, deduped case-insensitively, in document order. */
  flagged(text: string): FlaggedWord[];
  /** Up to 6 correction candidates (same cap as the modal). */
  suggest(word: string): string[];
  /** `text` with EVERY flagged occurrence of `lower` replaced by `replacement`,
   *  case preserved per occurrence. Whole-word, skip-aware, re-checked. */
  applyReplaceAll(text: string, lower: string, replacement: string): string;
}

/** The directory holding a dictionary package's index.aff/.dic (resolved through
 *  node_modules, mirroring scripts/build-spell-supplement.mjs). */
function dictDir(pkg: string): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve(pkg));
}

// Embedded-dict source for the COMPILED BINARY. `bun build --compile` does not embed
// the runtime `node_modules` reads above, so the standalone `dist/acm` would have no
// dictionaries beside it. cli.ts (which is outside the tsc `include`, like the SPA's
// embedded.generated) sets this from a generated module whose `with { type: "file" }`
// imports ARE embedded — readFileSync reads them on disk (source/built) and inside the
// binary alike. Unset in plain source mode → the node_modules path above is used.
type DictPaths = { aff: string; dic: string };
let embeddedDicts: Partial<Record<SpellVariant, DictPaths>> | null = null;
export function setEmbeddedDicts(map: Partial<Record<SpellVariant, DictPaths>>): void {
  embeddedDicts = map;
}

/** Build the speller for `variant`, pre-loaded with the supplement and the given
 *  personal-dictionary words. Synchronous (~50ms) — fine for a one-shot CLI. */
export function loadSpellEngine(variant: SpellVariant, personal: Iterable<string> = []): SpellEngine {
  // Prefer the embedded dicts (compiled binary); else resolve them from node_modules.
  const emb = embeddedDicts?.[variant];
  const paths =
    emb ?? (() => {
      const dir = dictDir(variant === "us" ? "dictionary-en" : "dictionary-en-gb");
      return { aff: join(dir, "index.aff"), dic: join(dir, "index.dic") };
    })();
  const speller: NSpell = nspell(readFileSync(paths.aff), readFileSync(paths.dic));
  for (const w of SPELL_SUPPLEMENT) speller.add(w);
  // Lowercased personal set: nspell honours it via .add, but an explicit set is the
  // same backstop the browser keeps (custom-word casing through nspell is imperfect).
  const personalSet = new Set<string>();
  for (const w of personal) {
    const lower = String(w).trim().toLowerCase();
    if (!lower) continue;
    personalSet.add(lower);
    speller.add(lower);
  }

  const isMisspelled = (word: string): boolean => {
    if (word.length < MIN_LEN) return false;
    if (personalSet.has(word.toLowerCase())) return false;
    return !speller.correct(word);
  };

  const collectSkipRanges = (text: string): Span[] => {
    const out: Span[] = [];
    skipParser.parse(text).iterate({
      enter: (node) => {
        if (SKIP_NODES.has(node.name)) {
          out.push({ from: node.from, to: node.to });
          return false; // whole region excluded — don't descend
        }
        return undefined;
      },
    });
    return out;
  };

  const flagged = (text: string): FlaggedWord[] => {
    const skip = collectSkipRanges(text);
    const re = wordRe();
    const seen = new Map<string, FlaggedWord>(); // insertion order == document order
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const word = m[0];
      if (word.length < MIN_LEN) continue;
      const from = m.index;
      if (overlapsSkip(skip, from, from + word.length)) continue;
      if (!isMisspelled(word)) continue;
      const lower = word.toLowerCase();
      const hit = seen.get(lower);
      if (hit) hit.count++;
      else seen.set(lower, { word, lower, count: 1, from });
    }
    return [...seen.values()];
  };

  const suggest = (word: string): string[] => speller.suggest(word).slice(0, 6);

  const applyReplaceAll = (text: string, lower: string, replacement: string): string => {
    const skip = collectSkipRanges(text);
    const re = wordRe();
    const edits: { from: number; to: number; insert: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const word = m[0];
      if (word.length < MIN_LEN || word.toLowerCase() !== lower) continue;
      const from = m.index;
      if (overlapsSkip(skip, from, from + word.length)) continue;
      if (!isMisspelled(word)) continue; // leave a correctly-cased homograph alone
      edits.push({ from, to: from + word.length, insert: matchCase(word, replacement) });
    }
    // Apply right-to-left so earlier offsets stay valid as we splice.
    let out = text;
    for (let i = edits.length - 1; i >= 0; i--) {
      out = out.slice(0, edits[i].from) + edits[i].insert + out.slice(edits[i].to);
    }
    return out;
  };

  return { flagged, suggest, applyReplaceAll };
}
