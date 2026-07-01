// Pins the drop-discriminator logic that churned across three commits
// (uri-list presence → data: decode → image-vs-hyperlink heuristic). The DOM
// handlers themselves are exercised live; these cover the pure decision fns.
import { describe, expect, test } from "bun:test";

import { fileFromDataUri, looksLikeRemoteImage } from "./imageInsert";

// 1×1 red PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("fileFromDataUri", () => {
  test("decodes a data:image/png URI into a pasted-style File", () => {
    const f = fileFromDataUri(`data:image/png;base64,${PNG_B64}`);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("dropped.png");
    expect(f!.type).toBe("image/png");
    expect(f!.size).toBe(70);
  });

  test("rejects unsupported image MIME types (no .png mislabelling)", () => {
    expect(fileFromDataUri(`data:image/tiff;base64,${PNG_B64}`)).toBeNull();
    expect(fileFromDataUri(`data:image/svg+xml;base64,${PNG_B64}`)).toBeNull();
  });

  test("rejects non-image and malformed URIs", () => {
    expect(fileFromDataUri(`data:text/html;base64,${PNG_B64}`)).toBeNull();
    expect(fileFromDataUri("data:image/png;base64,!!!not-base64!!!")).toBeNull();
    expect(fileFromDataUri("https://example.com/a.png")).toBeNull();
  });
});

describe("looksLikeRemoteImage", () => {
  test("an <img> in the drag's html payload is an image", () => {
    expect(looksLikeRemoteImage("https://example.com/x", '<img src="https://example.com/x">')).toBe(true);
    expect(looksLikeRemoteImage("https://example.com/x", "<img>")).toBe(true);
  });

  test("an image extension on the URL PATH is an image", () => {
    expect(looksLikeRemoteImage("https://example.com/photo.png", "")).toBe(true);
    expect(looksLikeRemoteImage("https://example.com/a/b.jpeg?w=800#frag", "")).toBe(true);
    expect(looksLikeRemoteImage("https://example.com/vector.svg", "")).toBe(true);
  });

  test("a plain hyperlink is NOT an image (falls through to text insert)", () => {
    expect(looksLikeRemoteImage("https://example.com/article", "")).toBe(false);
    expect(looksLikeRemoteImage("https://example.com/article", '<a href="https://example.com/article">x</a>')).toBe(false);
    // image extension in the QUERY is a redirect link, not an image (#3483)
    expect(looksLikeRemoteImage("https://example.com/redirect?target=photo.png", "")).toBe(false);
    expect(looksLikeRemoteImage("not a url at all", "")).toBe(false);
  });
});
