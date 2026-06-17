// Minimal ambient types for `nspell` (the package ships none). Only the surface
// the spellchecker uses — see editor/spellcheck.ts.
declare module "nspell" {
  export interface NSpell {
    /** True when `word` is spelled correctly (case- and affix-aware). */
    correct(word: string): boolean;
    /** Ranked correction candidates for a misspelled `word`. */
    suggest(word: string): string[];
    /** Teach the speller a word at runtime (used for the user's custom dictionary). */
    add(word: string, model?: string): NSpell;
    /** Forget a previously-added word. */
    remove(word: string): NSpell;
  }
  type Dict = string | Uint8Array;
  function nspell(aff: Dict | { aff: Dict; dic: Dict }, dic?: Dict): NSpell;
  export default nspell;
}
