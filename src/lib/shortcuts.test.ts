import { describe, expect, test } from "bun:test";

import { MOD } from "./platform";
import { selectionAuthoringShortcut, shortcutGroups } from "./shortcuts";

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

describe("shortcut cheat sheet", () => {
  test("the Formatting group lists bold, italic, underline and table insertion (#38)", () => {
    const formatting = shortcutGroups().find((g) => g.title === "Formatting");
    expect(formatting?.items).toEqual([
      { keys: `${MOD}B`, label: "Bold" },
      { keys: `${MOD}I`, label: "Italic" },
      { keys: `${MOD}U`, label: "Underline" },
      { keys: "/table ↵", label: "Insert table" },
    ]);
  });
});
