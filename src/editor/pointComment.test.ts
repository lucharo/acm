import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import { CriticMarkup } from "./criticMarkupParser";
import { isPointComment, pointCommentsField } from "./criticMarkupView";

function pointFlags(doc: string): boolean[] {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [CriticMarkup] }), pointCommentsField],
  });
  const flags: boolean[] = [];
  for (let at = doc.indexOf("{>>"); at >= 0; at = doc.indexOf("{>>", at + 1)) {
    flags.push(isPointComment(state, at));
  }
  return flags;
}

describe("point comments (#79)", () => {
  test("a comment after a highlight is anchored, and so is one stacked after it", () => {
    expect(pointFlags("See {==this span==}{>>@a: one<<}{>>@b: two<<} here.")).toEqual([false, false]);
  });

  test("a space between the highlight and its comment still anchors it", () => {
    expect(pointFlags("See {==this span==} {>>@a: one<<} here.")).toEqual([false]);
  });

  test("a comment with no highlight before it is a point comment", () => {
    expect(pointFlags("A sentence.{>>@a: point<<} More.")).toEqual([true]);
    expect(pointFlags("{>>@a: first<<}{>>@b: stacked<<}")).toEqual([true, true]);
  });
});
