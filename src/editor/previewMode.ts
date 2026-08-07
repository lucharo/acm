import type { Extension } from "@codemirror/state";

import { criticMarkupExtension } from "./criticMarkupView";
import { markdownPreview } from "./markdownPreview";
import { standaloneInsertionTokensField } from "./standaloneInsertion";

/** The document has one deliberate rich/raw switch. The Markdown buffer stays
 * canonical in both modes; raw mode simply removes every presentation layer. */
export function documentPreviewExtension(enabled: boolean): Extension {
  return enabled
    ? [standaloneInsertionTokensField, markdownPreview, criticMarkupExtension()]
    : [];
}
