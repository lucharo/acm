import { describe, expect, test } from "bun:test";

import {
  renderedTableCellSelector,
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
});
