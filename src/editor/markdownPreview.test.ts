import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { CriticMarkup } from "./criticMarkupParser";
import { standaloneInsertionTokensField } from "./standaloneInsertion";

import {
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
