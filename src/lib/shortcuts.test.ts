import { describe, expect, test } from "bun:test";

import { selectionAuthoringShortcut } from "./shortcuts";

describe("selected-text authoring shortcuts", () => {
  test("maps exact Mod-Alt-M/S chords to comment and suggestion actions", () => {
    expect(
      selectionAuthoringShortcut({
        code: "KeyM",
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toBe("comment");
    expect(
      selectionAuthoringShortcut({
        code: "KeyS",
        metaKey: false,
        ctrlKey: true,
        altKey: true,
        shiftKey: false,
      }),
    ).toBe("suggestion");
  });

  test("does not claim plain typing, Copy/Save-like chords, or shifted variants", () => {
    expect(
      selectionAuthoringShortcut({
        code: "KeyS",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
    expect(
      selectionAuthoringShortcut({
        code: "KeyM",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
    expect(
      selectionAuthoringShortcut({
        code: "KeyM",
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: true,
      }),
    ).toBeNull();
  });
});
