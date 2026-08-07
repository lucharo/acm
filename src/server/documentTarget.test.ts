import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDocumentTarget } from "./documentTarget";

const scratch: string[] = [];
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), "acm-target-"));
  scratch.push(path);
  return path;
};

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe("prepareDocumentTarget", () => {
  test("open returns an existing Markdown file without changing it", async () => {
    const cwd = temp();
    const path = join(cwd, "essay.md");
    writeFileSync(path, "hello\n");

    expect(prepareDocumentTarget("essay.md", cwd, "open")).toEqual({ ok: true, path, created: false });
    expect(await Bun.file(path).text()).toBe("hello\n");
  });

  test("create writes a new explicitly named Markdown file", () => {
    const cwd = temp();
    const path = join(cwd, "essay.md");

    expect(prepareDocumentTarget("essay.md", cwd, "create")).toEqual({ ok: true, path, created: true });
    expect(existsSync(path)).toBe(true);
  });

  test("create never overwrites an existing document", () => {
    const cwd = temp();
    writeFileSync(join(cwd, "essay.md"), "keep\n");

    expect(prepareDocumentTarget("essay.md", cwd, "create")).toEqual({
      ok: false,
      status: 409,
      message: "That document already exists. Open it instead.",
    });
  });

  test("open reports a missing document without creating it", () => {
    const cwd = temp();
    const path = join(cwd, "missing.md");

    expect(prepareDocumentTarget("missing.md", cwd, "open")).toEqual({
      ok: false,
      status: 404,
      message: "Document not found. Use New to create it.",
    });
    expect(existsSync(path)).toBe(false);
  });

  test("invalid extensions and missing parent folders are rejected", () => {
    const cwd = temp();
    expect(prepareDocumentTarget("essay.txt", cwd, "create")).toEqual({
      ok: false,
      status: 400,
      message: "ACM documents must use .md or .markdown.",
    });
    expect(prepareDocumentTarget("missing/essay.md", cwd, "create")).toEqual({
      ok: false,
      status: 400,
      message: "The document's parent folder does not exist.",
    });
    mkdirSync(join(cwd, "folder"));
    expect(prepareDocumentTarget("folder", cwd, "open")).toEqual({
      ok: false,
      status: 400,
      message: "ACM documents must use .md or .markdown.",
    });
  });
});
