/// <reference types="vite/client" />
// Brings in Vite's ambient module declarations.

// Virtual modules emitted by the dictionaryRaw plugin (vite.config.ts): the raw
// Hunspell .aff/.dic strings, inlined at build time from the `dictionary-en` (US)
// and `dictionary-en-gb` (UK) deps so the data never lives in git. The active
// variant is loaded lazily by editor/spellcheck.ts.
declare module "virtual:dict-en/aff" {
  const content: string;
  export default content;
}
declare module "virtual:dict-en/dic" {
  const content: string;
  export default content;
}
declare module "virtual:dict-en-gb/aff" {
  const content: string;
  export default content;
}
declare module "virtual:dict-en-gb/dic" {
  const content: string;
  export default content;
}
