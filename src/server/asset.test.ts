import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { assetFileName, assetRootFor, findGitRoot, resolveAsset, saveAsset } from "./asset";

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

describe("resolveAsset — doc directory only (no wider root)", () => {
  const docDir = `${sep}docs${sep}essay`;
  const under = (rel: string) => resolveAsset(docDir, docDir, rel);

  test("resolves paths inside the doc directory", () => {
    expect(under("assets/a.png")).toEqual({ ok: true, path: join(docDir, "assets", "a.png") });
    expect(under("figures/plot.png")).toEqual({ ok: true, path: join(docDir, "figures", "plot.png") });
  });

  test("blocks traversal above the doc directory", () => {
    expect(under("../secrets.png")).toEqual({ ok: false, reason: "outside-root" });
    expect(under("assets/../../secrets.png")).toEqual({ ok: false, reason: "outside-root" });
    expect(under("/etc/passwd")).toEqual({ ok: false, reason: "not-image" });
    expect(under("/etc/x.png")).toEqual({ ok: false, reason: "outside-root" });
  });

  test("serves only image types — not arbitrary files under docDir", () => {
    expect(under("settings.json")).toEqual({ ok: false, reason: "not-image" });
    expect(under("draft.md")).toEqual({ ok: false, reason: "not-image" });
    expect(under("noext")).toEqual({ ok: false, reason: "not-image" });
    // svg serves (hand-written refs) even though it isn't an upload type
    expect(under("figures/diagram.svg")).toEqual({ ok: true, path: join(docDir, "figures", "diagram.svg") });
  });

  test("a file or folder whose name starts with two dots is not traversal", () => {
    expect(under("..figure.png")).toEqual({ ok: true, path: join(docDir, "..figure.png") });
    expect(under("..drafts/x.png")).toEqual({ ok: true, path: join(docDir, "..drafts", "x.png") });
  });

  test("a sneaky same-prefix sibling dir does not pass the guard", () => {
    // /docs/essay-evil shares the string prefix but is NOT under /docs/essay.
    expect(under("../essay-evil/x.png")).toEqual({ ok: false, reason: "outside-root" });
  });
});

describe("resolveAsset — a wider asset root (#64)", () => {
  const root = `${sep}repo`;
  const docDir = join(root, "specs", "plan");

  test("a parent-relative image under the root resolves", () => {
    expect(resolveAsset(root, docDir, "../../org/docs/assets/run.png")).toEqual({
      ok: true,
      path: join(root, "org", "docs", "assets", "run.png"),
    });
  });

  test("a sibling assets/ image still resolves", () => {
    expect(resolveAsset(root, docDir, "assets/a.png")).toEqual({ ok: true, path: join(docDir, "assets", "a.png") });
  });

  test("a path above the root is blocked, and non-images stay refused inside it", () => {
    expect(resolveAsset(root, docDir, "../../../etc/x.png")).toEqual({ ok: false, reason: "outside-root" });
    expect(resolveAsset(root, docDir, "../../.env")).toEqual({ ok: false, reason: "not-image" });
    expect(resolveAsset(root, docDir, "../../package.json")).toEqual({ ok: false, reason: "not-image" });
  });

  test("an explicit root that does not contain the doc still serves the doc's own images", () => {
    const shared = `${sep}shared${sep}figures`;
    expect(resolveAsset(shared, docDir, "assets/a.png")).toEqual({ ok: true, path: join(docDir, "assets", "a.png") });
    expect(resolveAsset(shared, docDir, "/shared/figures/b.png")).toEqual({ ok: true, path: join(shared, "b.png") });
  });

  test("a filesystem root as the asset root contains everything below it", () => {
    expect(resolveAsset(sep, docDir, "/figures/plot.png")).toEqual({ ok: true, path: join(sep, "figures", "plot.png") });
  });

  test("a symlink inside the root pointing outside it is blocked", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "acm-asset-link-")));
    const repo = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(join(repo, "docs"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.png"), "x");
    symlinkSync(join(outside, "secret.png"), join(repo, "docs", "leak.png"));

    expect(resolveAsset(repo, join(repo, "docs"), "leak.png")).toEqual({ ok: false, reason: "outside-root" });
  });
});

describe("resolveAsset — a symlink must point at an image too", () => {
  test("an image-named link inside the root to a secret inside the root is refused", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "acm-asset-secret-")));
    mkdirSync(join(base, "assets"));
    mkdirSync(join(base, "specs", "plan"), { recursive: true });
    writeFileSync(join(base, ".env"), "TOKEN=secret\n");
    symlinkSync(join(base, ".env"), join(base, "assets", "leak.png"));
    writeFileSync(join(base, "assets", "real.png"), "x");
    symlinkSync(join(base, "assets", "real.png"), join(base, "assets", "alias.png"));

    expect(resolveAsset(base, join(base, "specs", "plan"), "../../assets/leak.png")).toEqual({ ok: false, reason: "not-image" });
    expect(resolveAsset(base, join(base, "specs", "plan"), "../../assets/alias.png")).toEqual({
      ok: true,
      path: join(base, "assets", "alias.png"),
    });
  });
});

describe("assetRootFor", () => {
  test("an explicit root wins", () => {
    expect(assetRootFor("/x/y", "/x")).toBe("/x");
  });

  test("inside a git repo, the repo root", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "acm-asset-git-")));
    mkdirSync(join(base, ".git"));
    mkdirSync(join(base, "specs", "plan"), { recursive: true });

    expect(findGitRoot(join(base, "specs", "plan"))).toBe(base);
    expect(assetRootFor(join(base, "specs", "plan"))).toBe(base);
  });

  test("a worktree's .git file marks its root too", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "acm-asset-wt-")));
    writeFileSync(join(base, ".git"), "gitdir: /elsewhere\n");
    mkdirSync(join(base, "docs"));

    expect(assetRootFor(join(base, "docs"))).toBe(base);
  });

  test("outside any repo, the doc directory", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "acm-asset-norepo-")));
    expect(assetRootFor(base)).toBe(base);
  });
});
