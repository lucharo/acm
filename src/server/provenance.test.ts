import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  provenancePath,
  readDocumentProvenance,
  recordProvenanceWrite,
} from "./provenance";

describe("document provenance sidecar", () => {
  test("persists exact ranges while preserving earlier authors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-provenance-"));
    const doc = join(dir, "draft.md");
    const before = "Alpha beta gamma";
    const afterLuis = "Alpha BETA gamma";
    const afterClaude = "Alpha BETA GAMMA";
    await Bun.write(doc, before);

    await recordProvenanceWrite(doc, before, afterLuis, {
      author: "Luis",
      source: "human",
      timestamp: "2026-08-12T10:01:00.000Z",
      operation: "edit",
    });
    await recordProvenanceWrite(doc, afterLuis, afterClaude, {
      author: "Claude",
      source: "agent",
      timestamp: "2026-08-12T10:02:00.000Z",
      operation: "agent edit",
    });

    const state = await readDocumentProvenance(doc, afterClaude);
    expect(state.segments.map((segment) => ({
      text: afterClaude.slice(segment.from, segment.to),
      author: segment.author,
      source: segment.source,
    }))).toEqual([
      { text: "Alpha ", author: "Unknown", source: "baseline" },
      { text: "BETA", author: "Luis", source: "human" },
      { text: " ", author: "Unknown", source: "baseline" },
      { text: "GAMMA", author: "Claude", source: "agent" },
    ]);
    expect(state.events).toHaveLength(2);
    expect(JSON.parse(await Bun.file(provenancePath(doc)).text())).toEqual(state);
    expect(await Bun.file(join(dir, ".acm", ".gitignore")).text()).toBe("*\n");
  });

  test("starts a new inspectable baseline when no matching sidecar exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-provenance-"));
    const doc = join(dir, "draft.md");
    const content = "Existing prose";
    await Bun.write(doc, content);

    const state = await readDocumentProvenance(doc, content);

    expect(state.version).toBe(1);
    expect(state.contentLength).toBe(content.length);
    expect(state.events).toEqual([]);
    expect(state.segments).toEqual([
      expect.objectContaining({ from: 0, to: content.length, author: "Unknown", source: "baseline" }),
    ]);
  });

  test("rejects a same-length sidecar whose document content no longer matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-provenance-"));
    const doc = join(dir, "draft.md");
    await Bun.write(doc, "abc");
    await recordProvenanceWrite(doc, "abc", "ABC", {
      author: "Luis",
      source: "human",
      timestamp: "2026-08-12T10:01:00.000Z",
      operation: "edit",
    });
    await Bun.write(doc, "XYZ");

    const state = await readDocumentProvenance(doc, "XYZ");

    expect(state.events).toEqual([]);
    expect(state.segments).toEqual([
      expect.objectContaining({ from: 0, to: 3, author: "Unknown", source: "baseline" }),
    ]);
  });
});
