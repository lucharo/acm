import { describe, expect, test } from "bun:test";

import { composerKeyOutsideBox, mayDiscardDraft } from "./commentKeys";

describe("mayDiscardDraft", () => {
  test("closes an empty or whitespace-only draft without asking", () => {
    const asked: string[] = [];
    const ask = (message: string) => {
      asked.push(message);
      return false;
    };

    expect([mayDiscardDraft("", ask), mayDiscardDraft("  \n", ask)]).toEqual([true, true]);
    expect(asked).toEqual([]);
  });

  test("asks before discarding a draft with text and follows the answer", () => {
    const asked: string[] = [];
    const answer = (value: boolean) => (message: string) => {
      asked.push(message);
      return value;
    };

    expect([mayDiscardDraft("half a reply", answer(false)), mayDiscardDraft("half a reply", answer(true))]).toEqual([
      false,
      true,
    ]);
    expect(asked).toEqual(["Discard this reply?", "Discard this reply?"]);
  });
});

describe("composerKeyOutsideBox", () => {
  const key = (k: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}, tag = "DIV") => ({
    key: k,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    target: { tagName: tag },
  });

  test("with focus back in the document, Mod-Enter posts, Mod-Shift-Enter posts and marks done, Escape cancels", () => {
    expect([
      composerKeyOutsideBox(key("Enter", { meta: true })),
      composerKeyOutsideBox(key("Enter", { ctrl: true })),
      composerKeyOutsideBox(key("Enter", { meta: true, shift: true })),
      composerKeyOutsideBox(key("Escape")),
    ]).toEqual(["post", "post", "post-done", "cancel"]);
  });

  test("plain typing in the document stays the document's: Enter, Shift-Enter and Alt combos are not composer keys", () => {
    expect([
      composerKeyOutsideBox(key("Enter")),
      composerKeyOutsideBox(key("Enter", { shift: true })),
      composerKeyOutsideBox(key("Enter", { meta: true, alt: true })),
      composerKeyOutsideBox(key("a", { meta: true })),
    ]).toEqual([null, null, null, null]);
  });

  test("a key in a text field (the composer box itself, a reply box, a setting) is left to that field", () => {
    expect(["TEXTAREA", "INPUT", "SELECT"].map((tag) => composerKeyOutsideBox(key("Enter", { meta: true }, tag)))).toEqual([
      null,
      null,
      null,
    ]);
  });
});
