import { describe, expect, test } from "bun:test";

import { isPrintShortcut } from "./printShortcut";

describe("print shortcut", () => {
  test("accepts Command-P and Ctrl-P", () => {
    expect(isPrintShortcut({ key: "p", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(true);
    expect(isPrintShortcut({ key: "P", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })).toBe(true);
  });

  test("does not intercept an unmodified P key", () => {
    expect(isPrintShortcut({ key: "p", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false);
  });

  test("leaves modified browser shortcuts alone", () => {
    expect(isPrintShortcut({ key: "p", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })).toBe(false);
    expect(isPrintShortcut({ key: "p", metaKey: false, ctrlKey: true, shiftKey: false, altKey: true })).toBe(false);
  });
});
