import { describe, expect, test } from "bun:test";
import { documentFileName, documentTabTitle } from "./documentTitle";

describe("documentTabTitle", () => {
  test("names the file, not the directory", () => {
    expect(documentTabTitle("/Users/me/specs/plan.md")).toBe("plan.md — ACM");
  });

  test("the header's file name is the last path segment", () => {
    expect(documentFileName("/Users/me/specs/plan.md")).toBe("plan.md");
  });

  test("handles a Windows-style separator", () => {
    expect(documentTabTitle("C:\\docs\\plan.md")).toBe("plan.md — ACM");
  });
});
