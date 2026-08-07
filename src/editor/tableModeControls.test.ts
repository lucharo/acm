import { describe, expect, test } from "bun:test";
import {
  commentsTogglePresentation,
  headerIconButtonClass,
  previewModePresentation,
} from "../components/Header";

describe("global preview mode control", () => {
  test("uses a compact code icon to enter raw source mode", () => {
    expect(previewModePresentation(true)).toEqual({
      label: "Show raw Markdown source",
      icon: "code",
    });
  });

  test("uses an eye icon to return to rich preview", () => {
    expect(previewModePresentation(false)).toEqual({
      label: "Show rich preview",
      icon: "eye",
    });
  });
});

describe("comments surface control", () => {
  test("uses bottom-sheet language on a narrow screen", () => {
    expect(commentsTogglePresentation(true, "sheet")).toEqual({
      label: "Hide comments",
      icon: "message-square",
    });
    expect(commentsTogglePresentation(false, "sheet")).toEqual({
      label: "Show comments",
      icon: "message-square",
    });
  });

  test("keeps edge language for the desktop rail", () => {
    expect(commentsTogglePresentation(true, "rail")).toEqual({
      label: "Hide comments edge",
      icon: "panel-right",
    });
  });
});

test("header controls remain touch-sized through tablet widths", () => {
  expect(headerIconButtonClass).toContain("h-10 w-10");
  expect(headerIconButtonClass).toContain("lg:h-7 lg:w-7");
  expect(headerIconButtonClass).not.toContain("sm:h-7");
});
