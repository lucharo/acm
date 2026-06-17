# English spelling dictionary (build-time, from the `dictionary-en` dep)

The spellchecker uses the en_US Hunspell dictionary from the
[`dictionary-en`](https://github.com/wooorm/dictionaries/tree/main/dictionaries/en)
npm package. The `.aff`/`.dic` data is **not committed** — it's ~540KB / ~50k
lines and would just be noise in git.

Instead, the Vite plugin `acm:dictionary-en-raw` (in `vite.config.ts`) reads the
two files straight from `node_modules/dictionary-en` at build time and inlines
them as the virtual modules `virtual:dict-en/aff` and `virtual:dict-en/dic`, which
`editor/spellcheck.ts` lazy-imports. So:

- the dictionary still ends up in the build chunk **and** the compiled binary
  (`bun build --compile`), with no runtime fetch;
- git stays clean — the dep (pinned in `bun.lock`, restored by `bun install`) is
  the single source of truth;
- reading by filesystem path sidesteps `dictionary-en`'s single-string `exports`,
  which blocks subpath `?raw` imports.

`LICENSE` is kept here for attribution, since the shipped build/binary embeds the
dictionary data (it's MIT AND BSD). To update the dictionary, bump the
`dictionary-en` dependency.
