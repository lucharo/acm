import { describe, expect, test } from "bun:test";
import { reconcileSave } from "./reconcile";

// The invariant under test: a "conflict" decision NEVER carries a version (the caller
// must not advance currentVersion past what the buffer descends from); only saved/
// reflush/rebased advance. That is what stops the next save from fast-path-clobbering.

describe("reconcileSave — plain success (no concurrent typing, no merge)", () => {
  test("server stored exactly what we sent → saved, no adopt", () => {
    const d = reconcileSave({ status: 200, version: 5, serverContent: "doc", sent: "doc", buffer: "doc" });
    expect(d).toEqual({ kind: "saved", version: 5, adopt: undefined });
  });
  test("buffer already cleared (null) → saved", () => {
    const d = reconcileSave({ status: 200, version: 5, serverContent: "doc", sent: "doc", buffer: null });
    expect(d.kind).toBe("saved");
  });
});

describe("reconcileSave — server merged in a concurrent agent write", () => {
  test("no new keystrokes → adopt the merged content", () => {
    const d = reconcileSave({
      status: 200,
      version: 6,
      serverContent: "doc+CARD",
      sent: "doc",
      buffer: "doc",
    });
    expect(d).toEqual({ kind: "saved", version: 6, adopt: "doc+CARD" });
  });

  test("kept typing on a DISJOINT line → rebased (keystrokes + card both survive)", () => {
    const base = "L0\nL1\nL2\n";
    const sent = "L0\nL1\nL2\n";
    const buffer = "L0EDIT\nL1\nL2\n"; // user kept typing on line 0
    const serverContent = "L0\nL1\nL2{>>@a: card<<}\n"; // agent card on line 2 (disjoint)
    const d = reconcileSave({ status: 200, version: 7, serverContent, sent, buffer });
    expect(d.kind).toBe("rebased");
    if (d.kind === "rebased") {
      expect(d.version).toBe(7);
      expect(d.pending.includes("L0EDIT")).toBe(true); // keystrokes kept
      expect(d.pending.includes("@a: card")).toBe(true); // card kept
    }
  });
});

describe("reconcileSave — the HIGH the 3rd-pass review found: never advance on conflict", () => {
  test("kept typing on the SAME line as the merged-in card → conflict, NO version", () => {
    const sent = "the quick fox\n";
    const buffer = "the QUICK SWIFT fox\n"; // user rewrote the same line
    const serverContent = "the quick {==fox==}{>>@a: SUGGEST: hare<<}\n"; // agent card on that line
    const d = reconcileSave({ status: 200, version: 9, serverContent, sent, buffer });
    expect(d.kind).toBe("conflict");
    // No `version` field → the caller keeps currentVersion at baseVersion → next save
    // re-merges server-side instead of fast-path-overwriting the card.
    expect("version" in d).toBe(false);
  });

  test("server 409 (overlap/cursor/stale) → conflict, NO version (Codex stale-clobber fix)", () => {
    const d = reconcileSave({
      status: 409,
      version: 42,
      serverContent: "whatever disk holds",
      sent: "my stale buffer",
      buffer: "my stale buffer",
    });
    expect(d.kind).toBe("conflict");
    expect("version" in d).toBe(false);
  });
});

describe("reconcileSave — kept typing, server stored exactly what we sent", () => {
  test("→ reflush to persist the newer keystrokes", () => {
    const d = reconcileSave({ status: 200, version: 8, serverContent: "doc", sent: "doc", buffer: "doc+more" });
    expect(d).toEqual({ kind: "reflush", version: 8 });
  });
});

describe("reconcileSave — malformed response never advances the base", () => {
  test("2xx with no/!numeric version → failed (keep pending, don't poison currentVersion)", () => {
    expect(reconcileSave({ status: 200, version: undefined, serverContent: undefined, sent: "x", buffer: "x" })).toEqual({
      kind: "failed",
    });
    expect(reconcileSave({ status: 200, version: "5" as unknown, serverContent: "x", sent: "x", buffer: "x" }).kind).toBe(
      "failed",
    );
  });
});
