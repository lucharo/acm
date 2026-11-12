import { describe, expect, test } from "bun:test";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { handleCommentKey, mayDiscardDraft } from "./commentKeys";

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

describe("handleCommentKey", () => {
  // Every comment box (the composer, the sidebar reply box, the mobile sheet) shares
  // this keyboard model; it had no test of its own.
  function press(key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}) {
    const calls: string[] = [];
    let prevented = false;
    const event = {
      key,
      metaKey: mods.meta ?? false,
      ctrlKey: mods.ctrl ?? false,
      shiftKey: mods.shift ?? false,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as ReactKeyboardEvent;
    handleCommentKey(
      event,
      () => calls.push("submit"),
      () => calls.push("submit-done"),
      () => calls.push("cancel"),
    );
    return { calls, prevented };
  }

  test("each key does what its label says, and only the keys it handles are taken from the text box", () => {
    expect({
      enter: press("Enter"),
      modEnter: press("Enter", { meta: true }),
      ctrlEnter: press("Enter", { ctrl: true }),
      modShiftEnter: press("Enter", { meta: true, shift: true }),
      ctrlShiftEnter: press("Enter", { ctrl: true, shift: true }),
      shiftEnter: press("Enter", { shift: true }),
      escape: press("Escape"),
      letter: press("a", { meta: true }),
    }).toEqual({
      enter: { calls: ["submit"], prevented: true },
      modEnter: { calls: ["submit"], prevented: true },
      ctrlEnter: { calls: ["submit"], prevented: true },
      modShiftEnter: { calls: ["submit-done"], prevented: true },
      ctrlShiftEnter: { calls: ["submit-done"], prevented: true },
      shiftEnter: { calls: [], prevented: false },
      escape: { calls: ["cancel"], prevented: true },
      letter: { calls: [], prevented: false },
    });
  });
});
