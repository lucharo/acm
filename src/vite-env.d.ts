/// <reference types="vite/client" />
// Brings in Vite's ambient module declarations.

// Virtual modules emitted by the dictionary-en-raw plugin (vite.config.ts): the
// raw Hunspell .aff/.dic strings, inlined at build time from the `dictionary-en`
// dep so the data never lives in git. Consumed by editor/spellcheck.ts.
declare module "virtual:dict-en/aff" {
  const content: string;
  export default content;
}
declare module "virtual:dict-en/dic" {
  const content: string;
  export default content;
}
