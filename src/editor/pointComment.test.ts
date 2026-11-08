import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import { CriticMarkup } from "./criticMarkupParser";
import { commentStacks, isPointComment, pointCommentsField } from "./criticMarkupView";

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

describe("stacked comment dots (#79)", () => {
  test("comments written one after another form one stack; a gap starts another", () => {
    const doc = "a {==b==}{>>1<<}{>>2<<}{>>3<<} c {==d==}{>>4<<}";
    const stacks = commentStacks(doc);
    const offsets = [...doc.matchAll(/\{>>/g)].map((m) => m.index);

    expect(offsets.map((from) => stacks.get(from))).toEqual([
      { index: 0, size: 3 },
      { index: 1, size: 3 },
      { index: 2, size: 3 },
      { index: 0, size: 1 },
    ]);
  });

  test("a SUGGEST comment, drawn as its own widget, is not counted as a dot", () => {
    const doc = "a {==b==}{>>@c: SUGGEST: B<<}{>>1<<}{>>2<<}";
    const stacks = commentStacks(doc);
    const offsets = [...doc.matchAll(/\{>>/g)].map((m) => m.index);

    expect(offsets.map((from) => stacks.get(from))).toEqual([
      undefined,
      { index: 0, size: 2 },
      { index: 1, size: 2 },
    ]);
  });
});
