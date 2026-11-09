import { expect, test } from "bun:test";
import { Text } from "@codemirror/state";

import { lineNumberDecorations } from "./lineNumbers";

const doc = Text.of(["# Title", "", "A paragraph", "> A quote"]);

function numbered(ranges: { from: number; to: number }[], text = doc) {
  const found: Array<{ from: number; number: string }> = [];
  lineNumberDecorations(text, ranges).between(0, text.length, (from, _to, value) => {
    found.push({ from, number: value.spec.attributes["data-ln"] });
  });
  return found;
}

test("every line in view is numbered from the document, blank lines included", () => {
  const visible = [{ from: 8, to: doc.length }];

  const lines = numbered(visible);

  expect(lines).toEqual([
    { from: 8, number: "2" },
    { from: 9, number: "3" },
    { from: 21, number: "4" },
  ]);
});

test("a line reaching into two visible ranges is numbered once", () => {
  const visible = [
    { from: 0, to: 12 },
    { from: 15, to: 18 },
  ];

  const lines = numbered(visible);

  expect(lines).toEqual([
    { from: 0, number: "1" },
    { from: 8, number: "2" },
    { from: 9, number: "3" },
  ]);
});

test("an empty document, which has no visible ranges, still numbers its first line", () => {
  const empty = Text.of([""]);

  const lines = numbered([], empty);

  expect(lines).toEqual([{ from: 0, number: "1" }]);
});
