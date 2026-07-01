import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { assetFileName, saveAsset, resolveUnderDocDir } from "./asset";

const bytes = (s: string) => new TextEncoder().encode(s);
/** Bytes that sniff as the given type (real magic numbers + a varying tail). */
const magic: Record<string, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff, 0xe0],
  gif: [...bytes("GIF89a")],
  webp: [...bytes("RIFF"), 0, 0, 0, 0, ...bytes("WEBP")],
  bmp: [...bytes("BM")],
  avif: [0, 0, 0, 0x20, ...bytes("ftypavif")],
};
const img = (type: string, tail = "") => new Uint8Array([...magic[type], ...bytes(tail)]);

describe("assetFileName", () => {
  test("slugs the stem and appends a content hash", () => {
    const name = assetFileName("My Screenshot (2).png", img("png"));
    expect(name).toMatch(/^my-screenshot-2-[0-9a-f]{8}\.png$/);
  });

  test("is deterministic: same name + same bytes → same file (dedup)", () => {
    expect(assetFileName("cat.png", img("png"))).toBe(assetFileName("cat.png", img("png")));
  });

  test("different bytes → different file (no silent overwrite)", () => {
    expect(assetFileName("cat.png", img("png", "a"))).not.toBe(assetFileName("cat.png", img("png", "b")));
  });

  test("rejects non-image extensions", () => {
    expect(assetFileName("notes.pdf", img("png"))).toBeNull();
    expect(assetFileName("data.csv", bytes("a,b"))).toBeNull();
    expect(assetFileName("noext", img("png"))).toBeNull();
  });

  test("rejects bytes that don't sniff as the claimed extension (roborev #3439)", () => {
    expect(assetFileName("payload.png", bytes("<script>alert(1)</script>"))).toBeNull();
    expect(assetFileName("photo.png", img("jpg"))).toBeNull(); // JPEG bytes, PNG name
    expect(assetFileName("photo.jpg", img("png"))).toBeNull(); // PNG bytes, JPEG name
  });

  test("accepts each supported type; jpg/jpeg are one type", () => {
    for (const t of ["png", "gif", "webp", "bmp", "avif"]) {
      expect(assetFileName(`f.${t}`, img(t))).toMatch(new RegExp(`^f-[0-9a-f]{8}\\.${t}$`));
    }
    expect(assetFileName("f.jpg", img("jpg"))).toMatch(/^f-[0-9a-f]{8}\.jpg$/);
    expect(assetFileName("f.jpeg", img("jpg"))).toMatch(/^f-[0-9a-f]{8}\.jpeg$/);
  });

  test("SVG is not an accepted upload type (stored-XSS surface)", () => {
    expect(assetFileName("diagram.svg", bytes("<svg onload=alert(1)/>"))).toBeNull();
  });

  test("uppercase extension and gnarly stems are normalised", () => {
    expect(assetFileName("IMG_0042.PNG", img("png"))).toMatch(/^img-0042-[0-9a-f]{8}\.png$/);
    expect(assetFileName("héllo wörld.jpg", img("jpg"))).toMatch(/^h-llo-w-rld-[0-9a-f]{8}\.jpg$/);
  });

  test("empty stem falls back to 'image'", () => {
    expect(assetFileName("….png", img("png"))).toMatch(/^image-[0-9a-f]{8}\.png$/);
  });
});

describe("saveAsset", () => {
  test("writes under assets/ and returns the doc-relative path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-asset-"));
    const payload = img("png", "pixels");
    const r = await saveAsset(dir, "shot.png", payload);
    expect(r).not.toBeNull();
    expect(r!.path).toMatch(/^assets\/shot-[0-9a-f]{8}\.png$/);
    expect(r!.stem).toBe("shot"); // the client's alt text — no scheme re-parsing
    expect(new Uint8Array(await Bun.file(join(dir, r!.path)).arrayBuffer())).toEqual(payload);
    // Re-save of identical content is a no-op returning the same path (dedup).
    expect((await saveAsset(dir, "shot.png", payload))!.path).toBe(r!.path);
  });

  test("returns null (writes nothing) for non-images and mislabelled bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-asset-"));
    expect(await saveAsset(dir, "notes.pdf", bytes("pdf"))).toBeNull();
    expect(await saveAsset(dir, "fake.png", bytes("not a png"))).toBeNull();
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
