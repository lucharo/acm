import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { assetFileName, saveAsset, resolveUnderDocDir } from "./asset";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("assetFileName", () => {
  test("slugs the stem and appends a content hash", () => {
    const name = assetFileName("My Screenshot (2).png", bytes("abc"));
    expect(name).toMatch(/^my-screenshot-2-[0-9a-f]{8}\.png$/);
  });

  test("is deterministic: same name + same bytes → same file (dedup)", () => {
    expect(assetFileName("cat.png", bytes("abc"))).toBe(assetFileName("cat.png", bytes("abc")));
  });

  test("different bytes → different file (no silent overwrite)", () => {
    expect(assetFileName("cat.png", bytes("abc"))).not.toBe(assetFileName("cat.png", bytes("xyz")));
  });

  test("rejects non-image extensions", () => {
    expect(assetFileName("notes.pdf", bytes("abc"))).toBeNull();
    expect(assetFileName("data.csv", bytes("abc"))).toBeNull();
    expect(assetFileName("noext", bytes("abc"))).toBeNull();
  });

  test("uppercase extension and gnarly stems are normalised", () => {
    expect(assetFileName("IMG_0042.PNG", bytes("abc"))).toMatch(/^img-0042-[0-9a-f]{8}\.png$/);
    expect(assetFileName("héllo wörld.jpg", bytes("abc"))).toMatch(/^h-llo-w-rld-[0-9a-f]{8}\.jpg$/);
  });

  test("empty stem falls back to 'image'", () => {
    expect(assetFileName("….png", bytes("abc"))).toMatch(/^image-[0-9a-f]{8}\.png$/);
  });
});

describe("saveAsset", () => {
  test("writes under assets/ and returns the doc-relative path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-asset-"));
    const r = await saveAsset(dir, "shot.png", bytes("pixels"));
    expect(r).not.toBeNull();
    expect(r!.path).toMatch(/^assets\/shot-[0-9a-f]{8}\.png$/);
    expect(await Bun.file(join(dir, r!.path)).text()).toBe("pixels");
  });

  test("returns null (writes nothing) for non-images", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-asset-"));
    expect(await saveAsset(dir, "notes.pdf", bytes("pdf"))).toBeNull();
  });
});

describe("resolveUnderDocDir", () => {
  const docDir = `${sep}docs${sep}essay`;

  test("resolves paths inside the doc directory", () => {
    expect(resolveUnderDocDir(docDir, "assets/a.png")).toBe(join(docDir, "assets", "a.png"));
    expect(resolveUnderDocDir(docDir, "figures/plot.png")).toBe(join(docDir, "figures", "plot.png"));
  });

  test("blocks traversal above the doc directory", () => {
    expect(resolveUnderDocDir(docDir, "../secrets.png")).toBeNull();
    expect(resolveUnderDocDir(docDir, "assets/../../secrets.png")).toBeNull();
    expect(resolveUnderDocDir(docDir, "/etc/passwd")).toBeNull();
  });

  test("a sneaky same-prefix sibling dir does not pass the guard", () => {
    // /docs/essay-evil shares the string prefix but is NOT under /docs/essay.
    expect(resolveUnderDocDir(docDir, "../essay-evil/x.png")).toBeNull();
  });
});
