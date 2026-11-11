import { describe, expect, test } from "bun:test";
import { suggestionSummary, wordDiff } from "./wordDiff";

describe("wordDiff", () => {
  test("marks only the words that changed and keeps the rest as they are", () => {
    const parts = wordDiff("And I just found myself again grabbing paper", "Once again I found myself grabbing paper");

    expect(parts).toEqual([
      { kind: "removed", text: "And " },
      { kind: "added", text: "Once again " },
      { kind: "same", text: "I " },
      { kind: "removed", text: "just " },
      { kind: "same", text: "found myself " },
      { kind: "removed", text: "again " },
      { kind: "same", text: "grabbing paper" },
    ]);
  });

  test("puts a removal before the addition that replaces it", () => {
    const parts = wordDiff("it was great", "it is great");

    expect(parts).toEqual([
      { kind: "same", text: "it " },
      { kind: "removed", text: "was " },
      { kind: "added", text: "is " },
      { kind: "same", text: "great" },
    ]);
  });

  test("a deletion is all removed, an addition all added", () => {
    expect(wordDiff("drop this", "")).toEqual([{ kind: "removed", text: "drop this" }]);
    expect(wordDiff("", "new words")).toEqual([{ kind: "added", text: "new words" }]);
  });

  test("a change in trailing space or punctuation counts as a changed word", () => {
    const parts = wordDiff("simple and it works", "simple, it works");

    expect(parts).toEqual([
      { kind: "removed", text: "simple and " },
      { kind: "added", text: "simple, " },
      { kind: "same", text: "it works" },
    ]);
  });

  test("keeps every character of both texts", () => {
    const before = "So with Agent Zen,  it's again\nthis idea";
    const after = "So Agent Zen is again\n\nthis idea of notes";

    const parts = wordDiff(before, after);

    expect(parts.filter((p) => p.kind !== "added").map((p) => p.text).join("")).toBe(before);
    expect(parts.filter((p) => p.kind !== "removed").map((p) => p.text).join("")).toBe(after);
  });

  test("texts too long to align come back as one removal and one addition", () => {
    const before = "a ".repeat(2500).trim();
    const after = "b ".repeat(2500).trim();

    expect(wordDiff(before, after)).toEqual([
      { kind: "removed", text: before },
      { kind: "added", text: after },
    ]);
  });
});

describe("suggestionSummary", () => {
  test("a replacement names both sides, clipped at a word", () => {
    const summary = suggestionSummary(
      "And I just found myself again grabbing a good old piece of paper",
      "Once again I found myself grabbing a good old piece of paper",
    );

    expect(summary).toEqual({
      kind: "replace",
      before: "And I just found myself again grabbing a good old…",
      after: "Once again I found myself grabbing a good old…",
    });
  });

  test("an empty replacement is a deletion and an empty span an addition", () => {
    expect(suggestionSummary("cut this", "  ")).toEqual({ kind: "delete", before: "cut this", after: "" });
    expect(suggestionSummary("", "add this")).toEqual({ kind: "add", before: "", after: "add this" });
  });

  test("short sides are kept whole, with line breaks shown as spaces", () => {
    expect(suggestionSummary("two\nlines", "one line")).toEqual({ kind: "replace", before: "two lines", after: "one line" });
  });
});
