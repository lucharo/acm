import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

export type DocumentTargetMode = "open" | "create" | "open-or-create";

export type DocumentTargetResult =
  | { ok: true; path: string; created: boolean }
  | { ok: false; status: 400 | 404 | 409; message: string };

function isMarkdownPath(path: string): boolean {
  return [".md", ".markdown"].includes(extname(path).toLowerCase());
}

export function prepareDocumentTarget(
  input: string,
  cwd: string,
  mode: DocumentTargetMode,
): DocumentTargetResult {
  const value = input.trim();
  if (!value) return { ok: false, status: 400, message: "Enter a document path." };
  const path = resolve(cwd, value);
  if (!isMarkdownPath(path)) {
    return { ok: false, status: 400, message: "ACM documents must use .md or .markdown." };
  }

  if (existsSync(path)) {
    if (!statSync(path).isFile()) {
      return { ok: false, status: 400, message: "That path is not a file." };
    }
    if (mode === "create") {
      return { ok: false, status: 409, message: "That document already exists. Open it instead." };
    }
    return { ok: true, path, created: false };
  }

  if (mode === "open") {
    return { ok: false, status: 404, message: "Document not found. Use New to create it." };
  }
  const parent = dirname(path);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    return { ok: false, status: 400, message: "The document's parent folder does not exist." };
  }
  try {
    writeFileSync(path, "", { flag: "wx" });
  } catch {
    return { ok: false, status: 409, message: "The document could not be created without overwriting a file." };
  }
  return { ok: true, path, created: true };
}
