import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";

import { scanTokens } from "../lib/criticmarkup";
import type { CommentToken } from "../lib/types";
import { runSuggestionDecision } from "./suggestionApply";

const REFUSAL = "Apply would break the markup, so nothing changed. Use Apply & resolve to apply this edit.";
const keepUnsafe = "A {==old==}{>>@a: SUGGEST: `<<}{>>@b: note<<} rest ` end.";

function run(doc: string, mode: "accept" | "reject", discussion: "keep-discussion" | "resolve-thread") {
  const dispatched: TransactionSpec[] = [];
  const toasts: string[] = [];
  const view = { state: EditorState.create({ doc }), dispatch: (spec: TransactionSpec) => dispatched.push(spec) };
  const comment = scanTokens(doc).find(
    (t): t is CommentToken => t.type === "comment" && t.body.includes("SUGGEST"),
  );
  if (!comment) throw new Error(`no SUGGEST comment in: ${doc}`);

  const changed = runSuggestionDecision(view as never, comment, mode, discussion, "Luis", (m) => toasts.push(m));

  return { changed, changes: dispatched.map((spec) => spec.changes), toasts };
}

describe("running a SUGGEST decision from the GUI (#9)", () => {
  test("plain Apply on a card only Apply & resolve can apply says why and changes nothing", () => {
    expect(run(keepUnsafe, "accept", "keep-discussion")).toEqual({
      changed: false,
      changes: [],
      toasts: [REFUSAL],
    });
  });

  test("Apply & resolve on that card applies with no message", () => {
    expect(run(keepUnsafe, "accept", "resolve-thread")).toEqual({
      changed: true,
      changes: [{ from: 2, to: 45, insert: "`" }],
      toasts: [],
    });
  });

  test("plain Apply on a safe card applies with no message", () => {
    expect(run("A {==old==}{>>@a: SUGGEST: new<<}{>>@b: note<<} end.", "accept", "keep-discussion")).toEqual({
      changed: true,
      changes: [{ from: 2, to: 47, insert: "{==new==}{>>@b: note<<}" }],
      toasts: [],
    });
  });

  test("Reject on that card restores the span with no message", () => {
    expect(run(keepUnsafe, "reject", "keep-discussion")).toEqual({
      changed: true,
      changes: [{ from: 2, to: 45, insert: "{==old==}{>>@b: note<<}" }],
      toasts: [],
    });
  });

  test("Apply on a suggestion with no anchored span stays silent", () => {
    expect(run("A {>>@a: SUGGEST: new<<} end.", "accept", "keep-discussion")).toEqual({
      changed: false,
      changes: [],
      toasts: [],
    });
  });
});
