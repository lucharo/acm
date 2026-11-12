// The comment composer and its blue anchor mark once the person clicks back into
// the document: an empty box closes (taking the mark with it), a box with text stays.
import { describe, expect, test } from "bun:test";
import { closesOnDocumentPointer } from "./useComposer";

describe("closesOnDocumentPointer", () => {
  test("an empty or whitespace-only draft closes the composer, so its highlight goes too", () => {
    expect([closesOnDocumentPointer(""), closesOnDocumentPointer("  \n")]).toEqual([true, true]);
  });

  test("a draft with text keeps the composer and the span it will attach to", () => {
    expect(closesOnDocumentPointer("half a comment")).toBe(false);
  });
});
