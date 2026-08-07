import { describe, expect, test } from "bun:test";

import { commentEdgeVisible, commentRailExpanded, commentStatusOccluded } from "./commentRail";

describe("comment edge visibility", () => {
  test("automatic mode hides an empty rail and opens for visible review cards", () => {
    expect(commentRailExpanded("auto", false, false)).toBe(false);
    expect(commentRailExpanded("auto", true, false)).toBe(true);
  });

  test("show and hide override the visible comment count", () => {
    expect(commentRailExpanded("show", false, false)).toBe(true);
    expect(commentRailExpanded("hide", true, false)).toBe(false);
  });

  test("an explicit authoring action temporarily opens the rail", () => {
    expect(commentRailExpanded("hide", true, true)).toBe(true);
  });

  test("the comments-edge toggle reflects the narrow mobile review surface", () => {
    expect(commentEdgeVisible("auto", false, false, true)).toBe(true);
    expect(commentEdgeVisible("hide", false, false, true)).toBe(false);
  });

  test("the rail-status pill hides only while a review card occupies its corner", () => {
    expect(commentStatusOccluded([{ top: 8, bottom: 96 }])).toBe(true);
    expect(commentStatusOccluded([{ top: 52, bottom: 140 }])).toBe(false);
    expect(commentStatusOccluded([{ top: -90, bottom: -2 }])).toBe(false);
  });

  test("any visible card can occlude the status corner after scrolling", () => {
    expect(
      commentStatusOccluded([
        { top: -120, bottom: -20 },
        { top: 20, bottom: 110 },
      ]),
    ).toBe(true);
  });
});
