import { describe, expect, test } from "bun:test";
import { imageFailureText } from "./imageFailure";

describe("imageFailureText", () => {
  test("a 403 says blocked, with the server's reason", () => {
    expect(imageFailureText("../../x.png", 403, "Blocked: outside the asset root /repo")).toBe(
      "⚠ ../../x.png (blocked: outside the asset root /repo)",
    );
    expect(imageFailureText("figures/photo.tiff", 403, "Blocked: not an image type")).toBe(
      "⚠ figures/photo.tiff (blocked: not an image type)",
    );
  });

  test("a 403 without a readable reason still says blocked", () => {
    expect(imageFailureText("x.png", 403, "")).toBe("⚠ x.png (blocked)");
  });

  test("a 404 or an unreadable status says missing", () => {
    expect(imageFailureText("gone.png", 404)).toBe("⚠ gone.png (missing)");
    expect(imageFailureText("https://example.com/x.png", null)).toBe("⚠ https://example.com/x.png (missing)");
  });
});
