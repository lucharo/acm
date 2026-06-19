# Spelling supplement is generated, not a fuller dictionary

**Status:** accepted

The bundled SCOWL/aspell dictionaries (`dictionary-en` US, `dictionary-en-gb` UK,
~50k stems each) omit a long tail of ordinary words — "transformative", "gameplay",
"rebranded" — and flag them as misspelled. Rather than swap to a larger base
dictionary, we ship a generated **supplement** (`src/editor/spell-supplement.ts`,
~1,369 words) merged on top of whichever variant is active, built by
`scripts/build-spell-supplement.mjs`.

## Considered options

- **A fuller drop-in dictionary** — rejected because none exists. LibreOffice's
  en_US is byte-identical to wooorm's; `dictionary-en-us` is deprecated in favour of
  `dictionary-en`; en-GB is the same SCOWL build. They all flag "transformative".
  The only genuinely larger lists (SCOWL "insane") start accepting real typos, which
  is worse for a writing tool.
- **A hand-curated word list** — rejected as whack-a-mole and unprincipled; it would
  grow by anecdote and rot.
- **Filter a raw frequency list** — rejected because every single corpus is
  junk-polluted: a web corpus's high-frequency tail is porn/spam, an encyclopedic
  corpus (Wikipedia) over-indexes place-names and administrative jargon.

## Decision

Keep words that are (a) valid per SCOWL's full ~275k list
(`an-array-of-english-words`), (b) flagged by **both** base dictionaries — so the
list is spelling-neutral and never leaks a US/UK spelling across the variant
toggle — and (c) common in **both** English Wikipedia **and** a web frequency
corpus. Intersecting two very different corpora cancels each one's domain-specific
junk; proper nouns the base dict already knows capitalised are dropped.

## Consequences

- The list is **reproducible**, not hand-maintained: re-run the script after any
  dictionary bump. A future reader who finds a 1,369-word array (or wonders why the
  script fetches Wikipedia and Google n-grams) should read the script header.
- Words rarer than the frequency cutoff are intentionally left to the personal
  dictionary ("Add to dictionary"), which is the per-user escape hatch.
- A handful of common proper names survive the filter. This is deliberate: a spell
  checker should accept "Marseille", and frequency alone cannot separate names from
  vocabulary. The only cost — a typo that coincides with a surname slips through —
  is inherent to any large dictionary.
