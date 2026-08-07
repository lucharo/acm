import { describe, expect, test } from "bun:test";

import {
  legacySeenQuarantinePatch,
  mergeConfigPatch,
  seenLocalStorageKey,
  seenPatchForDocument,
  seenStateForDocument,
} from "./seenState";

describe("per-document seen state", () => {
  test("identical comment identities remain independent across documents", () => {
    const key = "maya\u0000Same comment";
    const config = {
      seenByDocument: {
        "/docs/first.md": [key],
        "/docs/second.md": [],
      },
    };

    expect(seenStateForDocument(config, "/docs/first.md")).toEqual({
      keys: [key],
      source: "document",
    });
    expect(seenStateForDocument(config, "/docs/second.md")).toEqual({
      keys: [],
      source: "document",
    });
  });

  test("an explicit document slice keeps seen keys while their comments are temporarily absent", () => {
    const key = "maya\u0000Restored by undo";

    expect(
      seenStateForDocument(
        { seenByDocument: { "/docs/first.md": [key] } },
        "/docs/first.md",
        new Set(),
      ),
    ).toEqual({ keys: [key], source: "document" });
  });

  test("unscoped legacy seen state is quarantined instead of hiding matching comments", () => {
    const current = "maya\u0000Current";
    const other = "maya\u0000Other";
    const config = { seen: [current, other] };

    expect(
      seenStateForDocument(
        config,
        "/docs/current.md",
        new Set([current]),
      ),
    ).toEqual({ keys: [], source: "legacy" });
    expect(legacySeenQuarantinePatch(config)).toEqual({
      seen: [],
      seenLegacyQuarantine: [current, other],
    });
  });

  test("an empty legacy array does not trigger document migration", () => {
    expect(seenStateForDocument({ seen: [] }, "/docs/current.md")).toEqual({
      keys: [],
      source: "none",
    });
  });

  test("narrow patches preserve another document's seen state", () => {
    expect(
      mergeConfigPatch(
        { seenByDocument: { "/docs/first.md": ["first"] }, settings: { theme: "dark" } },
        { seenByDocument: { "/docs/second.md": ["second"] } },
      ),
    ).toEqual({
      seenByDocument: {
        "/docs/first.md": ["first"],
        "/docs/second.md": ["second"],
      },
      settings: { theme: "dark" },
    });
  });

  test("local cache keys cannot collide across documents", () => {
    expect(seenLocalStorageKey("/docs/first.md")).toBe(
      "acm-seen:%2Fdocs%2Ffirst.md",
    );
    expect(seenLocalStorageKey("/docs/second.md")).not.toBe(
      seenLocalStorageKey("/docs/first.md"),
    );
  });
});
