import { describe, expect, test } from "bun:test";

import { mayDiscardDraft } from "./commentKeys";

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
