#!/usr/bin/env bun
// Regenerates src/editor/spell-supplement.ts — the curated list of common words the
// bundled SCOWL Hunspell dictionaries (dictionary-en US + dictionary-en-gb UK) flag
// as misspelled even though they're perfectly ordinary ("transformative", "gameplay").
//
// Method: keep words that are (a) valid per SCOWL's full ~275k list
// (an-array-of-english-words), (b) flagged by BOTH base dictionaries (so the list is
// spelling-neutral and never leaks one region's spelling into the other), and (c)
// common in BOTH an encyclopedic corpus (English Wikipedia) AND a web corpus
// (Norvig/Google). Intersecting two very different corpora cancels each one's junk —
// web spam ranks near-zero on Wikipedia, encyclopedic place-names rank low on the web.
// Proper nouns the base dict already knows capitalised (York, November) are dropped.
//
// Reads the two base dictionaries from node_modules (the project's pinned versions);
// fetches the SCOWL list + both corpora from the network, so it needs no extra deps.
// Run: `bun scripts/build-spell-supplement.mjs`
import nspell from "nspell";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const WIKI_CUT = 50_000; // frequency-rank ceiling in the Wikipedia corpus
const WEB_CUT = 80_000; //  …and in the web corpus; a word must clear BOTH
const SCOWL_URL = "https://unpkg.com/an-array-of-english-words/index.json";
const WIKI_URL =
  "https://raw.githubusercontent.com/IlyaSemenov/wikipedia-word-frequency/master/results/enwiki-2023-04-13.txt";
const WEB_URL = "https://norvig.com/ngrams/count_1w.txt";

const req = createRequire(import.meta.url);
const loadDict = (pkg) => {
  const dir = dirname(req.resolve(pkg));
  return nspell(readFileSync(join(dir, "index.aff")), readFileSync(join(dir, "index.dic")));
};
const us = loadDict("dictionary-en");
const gb = loadDict("dictionary-en-gb");
const known = (w) => us.correct(w) || gb.correct(w);
const cap = (w) => w[0].toUpperCase() + w.slice(1);

const fetchText = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  return r.text();
};
// word → 1-based rank (file is frequency-sorted; first occurrence wins)
const rankMap = (txt, sep) => {
  const m = new Map();
  txt.split("\n").forEach((ln, i) => {
    const w = ln.split(sep)[0];
    if (w && !m.has(w)) m.set(w, i + 1);
  });
  return m;
};

console.error("fetching SCOWL word list + Wikipedia/web frequency corpora…");
const [scowlJson, wikiTxt, webTxt] = await Promise.all([
  fetchText(SCOWL_URL),
  fetchText(WIKI_URL),
  fetchText(WEB_URL),
]);
const scowl = JSON.parse(scowlJson);
const wiki = rankMap(wikiTxt, " ");
const web = rankMap(webTxt, "\t");

const alpha = /^[a-z]+$/;
const words = [];
for (const w of scowl) {
  if (w.length < 4 || !alpha.test(w)) continue; // skip 1–3 letter + non-pure-alpha tokens
  const rw = wiki.get(w);
  const rb = web.get(w);
  if (!rw || !rb || rw > WIKI_CUT || rb > WEB_CUT) continue; // must be common in BOTH
  if (known(w) || known(cap(w))) continue; // already valid, or a known proper noun
  words.push(w);
}
words.sort();

const rows = [];
for (let i = 0; i < words.length; i += 12)
  rows.push("  " + words.slice(i, i + 12).map((w) => JSON.stringify(w)).join(", ") + ",");

const out = `// ── Spell-check supplement: common words the base Hunspell dictionaries miss ─────
// The bundled \`dictionary-en\` (US) / \`dictionary-en-gb\` (UK) — SCOWL/aspell, ~50k
// stems each — omit a long tail of perfectly ordinary words ("transformative",
// "gameplay", "rebranded") and flag them as misspelled. This is a curated list of
// those gaps, merged into whichever variant is active. Every word here is flagged by
// BOTH dictionaries, so it is MOSTLY region-neutral — but "missing from both" is not
// the same as "region-neutral": a few regional spellings neither SCOWL build happens
// to contain (e.g. "annexe", "apnea") slip in and get accepted in both variants. That
// known minor leak is documented in docs/adr/0001. nspell handles casing, so the
// lowercase entry also covers Transformative / TRANSFORMATIVE.
//
// GENERATED — do not edit by hand. Regenerate with:
//   bun scripts/build-spell-supplement.mjs
// ${words.length} words. Anything rarer is left to the personal dictionary ("Add to
// dictionary"). See the script header for the exact derivation.

export const SPELL_SUPPLEMENT: readonly string[] = [
${rows.join("\n")}
];
`;

writeFileSync(new URL("../src/editor/spell-supplement.ts", import.meta.url), out);
console.error(`wrote src/editor/spell-supplement.ts (${words.length} words)`);
