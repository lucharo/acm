import type { EditorView } from "@codemirror/view";

import { suggestionThreadEdit } from "../lib/criticmarkup";
import type { SuggestionDiscussion } from "../lib/criticmarkup";
import { structuredSuggestionDecision } from "../lib/decision";
import type { CommentToken } from "../lib/types";
import { decisionAnnotations } from "./useCodeMirror";

/** Run one Apply / Reject on a structured SUGGEST as a single transaction carrying
 *  its decision event. Returns whether the document changed; `onRefused` says why
 *  when plain Apply can't keep the discussion but dropping it would still apply. */
export function runSuggestionDecision(
  view: Pick<EditorView, "state" | "dispatch">,
  comment: CommentToken,
  mode: "accept" | "reject",
  discussion: SuggestionDiscussion,
  actor: string,
  onRefused: (message: string) => void,
): boolean {
  const content = view.state.doc.toString();
  const effectiveDiscussion = mode === "accept" ? discussion : "keep-discussion";
  const edit = suggestionThreadEdit(content, comment, mode, effectiveDiscussion);
  if (!edit) {
    if (suggestionThreadEdit(content, comment, "accept", "resolve-thread")) {
      onRefused("Apply would break the markup, so nothing changed. Use Apply & resolve to apply this edit.");
    }
    return false;
  }
  const action =
    mode === "reject" ? "reject" : effectiveDiscussion === "resolve-thread" ? "apply-resolve" : "apply";
  const event = structuredSuggestionDecision(content, comment, mode, action, actor, "gui");
  if (!event) return false;
  view.dispatch({ changes: edit, annotations: decisionAnnotations([event]) });
  return true;
}
