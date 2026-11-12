import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { CriticMarkup } from "./criticMarkupParser";
import { standaloneInsertionTokensField } from "./standaloneInsertion";

import {
  buildHide,
  buildStyle,
  renderedTableCellSelector,
  tableCellReviewState,
  tableCellLinkSelection,
  tableCellPointerAction,
} from "./markdownPreview";

describe("rich table keyboard navigation", () => {
  test("an ordinary tap edits a linked cell while a modified click opens its link", () => {
    expect(tableCellPointerAction(false, false)).toBe("edit");
    expect(tableCellPointerAction(true, false)).toBe("edit");
    expect(tableCellPointerAction(true, true)).toBe("follow-link");
  });

  test("tapping a rendered link selects its readable label in the Markdown input", () => {
    expect(tableCellLinkSelection("[ACM project](https://example.com)", "ACM project")).toEqual({
      start: 1,
      end: 12,
    });
    expect(tableCellLinkSelection("**Bold link**", "Bold link")).toBeNull();
  });

  test("the same cell address is scoped to its owning table", () => {
    const address = { section: "body" as const, row: 0, column: 0 };

    expect(renderedTableCellSelector(10, address)).toBe(
      '[data-table-from="10"] [data-table-cell="body:0:0"]',
    );
    expect(renderedTableCellSelector(200, address)).toBe(
      '[data-table-from="200"] [data-table-cell="body:0:0"]',
    );
    expect(renderedTableCellSelector(10, address)).not.toBe(
      renderedTableCellSelector(200, address),
    );
  });

  test("commented cells expose accepted rich text and exact document offsets", () => {
    const value = "{==Result $x^2$==}{>>@Maya: Check this cell<<}";

    expect(tableCellReviewState(value, 40)).toEqual({
      markdown: "Result $x^2$",
      comments: [
        {
          from: 40 + value.indexOf("{>>"),
          author: "Maya",
          body: "Check this cell",
        },
      ],
    });
  });
});

describe("inline styles inside CriticMarkup (#85)", () => {
  function styledText(doc: string, className: string): string[] {
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [CriticMarkup] }),
        standaloneInsertionTokensField,
      ],
    });
    const view = { state, visibleRanges: [{ from: 0, to: doc.length }], hasFocus: false };
    const out: string[] = [];
    buildStyle(view as unknown as EditorView).between(0, doc.length, (from, to, deco) => {
      if (deco.spec.class === className) out.push(doc.slice(from, to));
    });
    return out;
  }

  test("an anchored code span keeps its code style", () => {
    const doc = "Run {==`bunx --bun skills add x`==}{>>@You: npx?<<} now.";

    expect(styledText(doc, "cm-md-code")).toEqual(["`bunx --bun skills add x`"]);
  });

  test("a comment body stays one opaque node, never styled", () => {
    expect(styledText("Text{>>@You: see `code` here<<}.", "cm-md-code")).toEqual([]);
  });
});

describe("underline preview (<u>…</u>, #38)", () => {
  function viewOf(doc: string, focus?: number, visible?: { from: number; to: number }[]) {
    const state = EditorState.create({
      doc,
      selection: focus === undefined ? undefined : { anchor: focus },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [CriticMarkup] }),
        standaloneInsertionTokensField,
      ],
    });
    return {
      state,
      visibleRanges: visible ?? [{ from: 0, to: doc.length }],
      hasFocus: focus !== undefined,
    } as unknown as EditorView;
  }

  function underlined(doc: string, visible?: { from: number; to: number }[]): string[] {
    const out: string[] = [];
    buildStyle(viewOf(doc, undefined, visible)).between(0, doc.length, (from, to, deco) => {
      if (deco.spec.class === "cm-md-underline") out.push(doc.slice(from, to));
    });
    return out;
  }

  function hidden(doc: string, focus?: number, visible?: { from: number; to: number }[]): string[] {
    const out: string[] = [];
    buildHide(viewOf(doc, focus, visible)).between(0, doc.length, (from, to) => {
      out.push(doc.slice(from, to));
    });
    return out;
  }

  test("a <u> span is drawn underlined, tags excluded", () => {
    expect(underlined("The plan is <u>really important</u> today.")).toEqual(["really important"]);
  });

  test("off the active line the tags are hidden", () => {
    expect(hidden("The plan is <u>really important</u> today.")).toEqual(["<u>", "</u>"]);
  });

  test("on the active line the tags are revealed for editing", () => {
    expect(hidden("The plan is <u>really important</u> today.", 0)).toEqual([]);
  });

  test("an unclosed <u> is neither underlined nor hidden", () => {
    const doc = "An <u>unclosed tag stays raw.";
    expect(underlined(doc)).toEqual([]);
    expect(hidden(doc)).toEqual([]);
  });

  test("other inline HTML tags are left alone, and never close with a stray </u>", () => {
    const doc = "Some <b>bold</b> and <span>span</u>.";
    expect(underlined(doc)).toEqual([]);
    expect(hidden(doc)).toEqual([]);
  });

  test("an underline inside a CriticMarkup highlight is still drawn", () => {
    expect(underlined("The {==<u>key</u> point==}{>>@You: why?<<} here.")).toEqual(["key"]);
  });

  test("a comment anchored across one tag keeps the underline (acm comment can write this)", () => {
    const doc = "A <u>very {==important</u> point==}{>>@You: why?<<}.";
    expect(underlined(doc)).toEqual(["very {==important"]);
    expect(hidden(doc).filter((t) => t.includes("u>"))).toEqual(["<u>", "</u>"]);
  });

  test("only the lowercase tags ACM writes are drawn; <U> stays raw", () => {
    const doc = "A <U>loud</U> word.";
    expect(underlined(doc)).toEqual([]);
    expect(hidden(doc)).toEqual([]);
  });

  test("a tag that crosses an emphasis boundary stays raw", () => {
    const doc = "A *very <u>key* point</u> here.";
    expect(underlined(doc)).toEqual([]);
    expect(hidden(doc).filter((t) => t.includes("u>"))).toEqual([]);
  });

  test("a closing tag broken over two lines stays raw and hides no line break", () => {
    const doc = "A <u>word</u\n    >. More text.";
    expect(underlined(doc)).toEqual([]);
    expect(hidden(doc)).toEqual([]);
  });

  test("a span whose tags lie outside the rendered viewport is still drawn", () => {
    const doc = "Start <u>one\ntwo\nthree</u> end.";
    const middle = doc.indexOf("two");
    const visible = [{ from: middle, to: middle + 3 }];
    expect(underlined(doc, visible)).toEqual(["one\ntwo\nthree"]);
    expect(hidden(doc, undefined, visible)).toEqual(["<u>", "</u>"]);
  });

  test("an underline wrapping bold text is drawn over the whole span", () => {
    expect(underlined("A <u>**bold** word</u>.")).toEqual(["**bold** word"]);
  });

  test("each of two spans on one line pairs with its own close tag", () => {
    expect(underlined("<u>one</u> and <u>two</u>")).toEqual(["one", "two"]);
  });
});
