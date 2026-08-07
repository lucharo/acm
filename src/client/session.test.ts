import { describe, expect, test } from "bun:test";
import { parseAcmSession } from "./session";

describe("parseAcmSession", () => {
  test("accepts a document session", () => {
    expect(parseAcmSession({ mode: "document", path: "/tmp/essay.md" })).toEqual({
      mode: "document",
      path: "/tmp/essay.md",
    });
  });

  test("accepts a launcher session with recent documents", () => {
    expect(
      parseAcmSession({
        mode: "launcher",
        cwd: "/tmp",
        recent: [{ path: "/tmp/essay.md", name: "essay.md", openedAt: "2026-08-06T12:00:00.000Z" }],
      }),
    ).toEqual({
      mode: "launcher",
      cwd: "/tmp",
      recent: [{ path: "/tmp/essay.md", name: "essay.md", openedAt: "2026-08-06T12:00:00.000Z" }],
    });
  });

  test("rejects malformed launcher data", () => {
    expect(() => parseAcmSession({ mode: "launcher", cwd: "/tmp", recent: [{ path: 1 }] })).toThrow(
      "incompatible session",
    );
  });
});
