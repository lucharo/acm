import { StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { isStandaloneInsertion, scanTokens } from "../lib/criticmarkup";
import type { InsertToken } from "../lib/types";

/** Standalone additions eligible for rich block replacement. Inline insertions
 * stay owned by the existing CriticMarkup mark/widget path. Global source mode
 * removes the whole preview extension rather than creating per-block modes. */
export function standaloneInsertionPreviews(content: string): InsertToken[] {
  return scanTokens(content).filter(
    (token): token is InsertToken =>
      token.type === "insert" &&
      isStandaloneInsertion(content, token),
  );
}

/** One document scan shared by every rich-preview layer. Decoration builders run
 * independently, so calling `standaloneInsertionPreviews` from each one multiplied
 * a full CriticMarkup scan on every edit. */
export const standaloneInsertionTokensField = StateField.define<InsertToken[]>({
  create: (state) => standaloneInsertionPreviews(state.doc.toString()),
  update(value, transaction) {
    return transaction.docChanged
      ? standaloneInsertionPreviews(transaction.newDoc.toString())
      : value;
  },
});

export function standaloneInsertionTokens(state: EditorState): InsertToken[] {
  return state.field(standaloneInsertionTokensField);
}
