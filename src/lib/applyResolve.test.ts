import { describe, expect, test } from "bun:test";
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  applyRangedEdits,
  scanTokens,
  suggestionGroupEdits,
  suggestionThreadEdit,
} from "./criticmarkup";
import type { CommentToken } from "./types";

function suggestionComment(content: string, replacement: string): CommentToken {
  const comment = scanTokens(content).find(
    (token): token is CommentToken =>
      token.type === "comment" && token.body.includes(`SUGGEST: ${replacement}`),
  );
  if (!comment) throw new Error(`missing suggestion for ${replacement}`);
  return comment;
}

describe("Apply & resolve", () => {
  test("ordinary Apply keeps the surrounding discussion open", () => {
    const content =
      "Pay {==the old wording==}{>>@a: context<<}{>>@b: SUGGEST: the new wording<<}{>>@c: follow-up<<}.";
    const comment = suggestionComment(content, "the new wording");

    const edit = suggestionThreadEdit(content, comment, "accept");

    expect(edit).not.toBeNull();
    expect(applyRangedEdits(content, [edit!])).toBe(
      "Pay {==the new wording==}{>>@a: context<<}{>>@c: follow-up<<}.",
    );
  });

  test("Apply & resolve accepts the wording and removes the complete thread", () => {
    const content =
      "Pay {==the old wording==}{>>@a: context<<}{>>@b: SUGGEST: the new wording<<}{>>@c: follow-up<<}.";
    const comment = suggestionComment(content, "the new wording");

    const edit = suggestionThreadEdit(content, comment, "accept", "resolve-thread");

    expect(edit).not.toBeNull();
    expect(applyRangedEdits(content, [edit!])).toBe("Pay the new wording.");
  });

  test("Apply & resolve handles an empty replacement without leaving point comments", () => {
    const content = "Cut {==this span==}{>>@a: SUGGEST:<<}{>>@b: agreed<<} now.";
    const comment = scanTokens(content).find(
      (token): token is CommentToken => token.type === "comment" && token.body.startsWith("SUGGEST:"),
    )!;

    const edit = suggestionThreadEdit(content, comment, "accept", "resolve-thread");

    expect(applyRangedEdits(content, [edit!])).toBe("Cut  now.");
  });

  test("Apply & resolve all uses the same behaviour for every group member", () => {
    const content =
      "A {==one==}{>>@a: SUGGEST[g:g1]: first<<}{>>@b: discuss<<}. " +
      "B {==two==}{>>@a: SUGGEST[g:g1]: second<<}{>>@c: discuss<<}.";

    const result = suggestionGroupEdits(content, "g1", "accept", "resolve-thread");

    expect(result).toEqual({
      edits: [
        {
          from: content.indexOf("{==one==}"),
          to: content.indexOf(". B"),
          insert: "first",
        },
        {
          from: content.indexOf("{==two==}"),
          to: content.lastIndexOf("."),
          insert: "second",
        },
      ],
      skipped: 0,
      unanchored: 0,
    });
    expect(applyRangedEdits(content, result.edits)).toBe("A first. B second.");
  });

  test("Apply & resolve all preserves a thread containing competing group members", () => {
    const content =
      "A {==one==}{>>@a: SUGGEST[g:g1]: first<<}{>>@b: SUGGEST[g:g1]: alternative<<}.";

    const result = suggestionGroupEdits(content, "g1", "accept", "resolve-thread");

    expect(result).toEqual({ edits: [], skipped: 2, unanchored: 0 });
    expect(applyRangedEdits(content, result.edits)).toBe(content);
  });

  test("the combined edit is restored by one CodeMirror undo", () => {
    const content = "Pay {==old==}{>>@a: SUGGEST: new<<}{>>@b: why?<<}.";
    const comment = suggestionComment(content, "new");
    const edit = suggestionThreadEdit(content, comment, "accept", "resolve-thread")!;
    let current = EditorState.create({ doc: content, extensions: [history()] });
    const target = {
      get state() {
        return current;
      },
      dispatch(spec: Parameters<EditorState["update"]>[0]) {
        current = current.update(spec).state;
      },
    } as unknown as EditorView;

    target.dispatch({ changes: edit });
    expect(current.doc.toString()).toBe("Pay new.");
    expect(undo(target)).toBe(true);
    expect(current.doc.toString()).toBe(content);
  });
});

function groupMemberId(content: string, replacement: string): string {
  const comment = scanTokens(content).find(
    (token): token is CommentToken =>
      token.type === "comment" && token.body.endsWith(`]: ${replacement}`),
  );
  if (!comment) throw new Error(`missing group member ${replacement}`);
  return comment.id;
}

describe("applying only the ticked members of a group (#25)", () => {
  const three =
    "A {==one==}{>>@a: SUGGEST[g:g1]: first<<}. " +
    "B {==two==}{>>@a: SUGGEST[g:g1]: second<<}. " +
    "C {==three==}{>>@a: SUGGEST[g:g1]: third<<}.";

  test("Apply changes the ticked members and leaves the unticked one as an open suggestion", () => {
    const only = new Set([groupMemberId(three, "first"), groupMemberId(three, "third")]);

    const result = suggestionGroupEdits(three, "g1", "accept", "keep-discussion", only);

    expect(result.skipped).toBe(0);
    expect(result.unanchored).toBe(0);
    expect(applyRangedEdits(three, result.edits)).toBe(
      "A first. B {==two==}{>>@a: SUGGEST[g:g1]: second<<}. C third.",
    );
  });

  test("Reject restores only the ticked members' original spans", () => {
    const only = new Set([groupMemberId(three, "second")]);

    const result = suggestionGroupEdits(three, "g1", "reject", "keep-discussion", only);

    expect(applyRangedEdits(three, result.edits)).toBe(
      "A {==one==}{>>@a: SUGGEST[g:g1]: first<<}. B two. C {==three==}{>>@a: SUGGEST[g:g1]: third<<}.",
    );
  });

  test("Apply keeps an unticked competing proposal in the same thread", () => {
    const content =
      "A {==one==}{>>@a: SUGGEST[g:g1]: first<<}{>>@b: SUGGEST[g:g1]: alternative<<}.";
    const only = new Set([groupMemberId(content, "first")]);

    const result = suggestionGroupEdits(content, "g1", "accept", "keep-discussion", only);

    expect(result.skipped).toBe(0);
    expect(applyRangedEdits(content, result.edits)).toBe(
      "A {==first==}{>>@b: SUGGEST[g:g1]: alternative<<}.",
    );
  });

  test("Apply & resolve holds back a ticked member whose thread holds an unticked one", () => {
    const content =
      "A {==one==}{>>@a: SUGGEST[g:g1]: first<<}{>>@b: SUGGEST[g:g1]: alternative<<}. " +
      "B {==two==}{>>@a: SUGGEST[g:g1]: second<<}.";
    const only = new Set([groupMemberId(content, "first"), groupMemberId(content, "second")]);

    const result = suggestionGroupEdits(content, "g1", "accept", "resolve-thread", only);

    expect(result.skipped).toBe(1);
    expect(applyRangedEdits(content, result.edits)).toBe(
      "A {==one==}{>>@a: SUGGEST[g:g1]: first<<}{>>@b: SUGGEST[g:g1]: alternative<<}. B second.",
    );
  });

  test("a member without an anchor still blocks a ticked subset", () => {
    const doc =
      "The {==universal mind==}{>>@claude: SUGGEST[g:um]: universal mind[^um]<<} idea.\n\n" +
      "[^a]: old def.{>>@claude: SUGGEST[g:um]: old def.\n[^um]: the def.<<}\n";
    const only = new Set([groupMemberId(doc, "universal mind[^um]")]);

    const result = suggestionGroupEdits(doc, "um", "accept", "keep-discussion", only);

    expect(result).toEqual({ edits: [], skipped: 2, unanchored: 1 });
  });
});
