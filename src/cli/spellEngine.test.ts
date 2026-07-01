import { describe, expect, test } from "bun:test";
import { loadSpellEngine } from "./spellEngine";

// One UK speller, reused across the read-only assertions (~50ms to build).
const engine = loadSpellEngine("uk");
const lowers = (text: string) => engine.flagged(text).map((w) => w.lower);

describe("loadSpellEngine — flagged()", () => {
  test("flags a real misspelling in prose", () => {
    expect(lowers("We recieve the parcel.")).toContain("recieve");
  });

  test("does not flag correctly-spelled prose", () => {
    expect(engine.flagged("We receive the parcel today.")).toEqual([]);
  });

  test("ignores tokens below the length floor (MIN_LEN)", () => {
    // 2-letter junk is never flagged — the dictionary's short-token coverage is poor.
    expect(engine.flagged("qz xj")).toEqual([]);
  });

  test("honours the bundled supplement", () => {
    // "transformative" is in SPELL_SUPPLEMENT (both base SCOWL dicts miss it).
    expect(lowers("a transformative idea")).not.toContain("transformative");
  });

  test("honours injected personal-dictionary words", () => {
    const withWord = loadSpellEngine("uk", ["Zyxwv"]); // added lowercased
    expect(withWord.flagged("the zyxwv protocol")).toEqual([]);
    // …and the same nonsense word IS flagged without the personal entry.
    expect(lowers("the zyxwv protocol")).toContain("zyxwv");
  });

  test("dedups case-insensitively with a count, in document order", () => {
    const out = engine.flagged("Recieve. teh. recieve. RECIEVE.");
    expect(out.map((w) => w.lower)).toEqual(["recieve", "teh"]); // first-occurrence order
    const recieve = out.find((w) => w.lower === "recieve")!;
    expect(recieve.count).toBe(3); // Recieve + recieve + RECIEVE
    expect(recieve.word).toBe("Recieve"); // representative = first surface form
  });
});

describe("loadSpellEngine — skip regions (parity with the editor)", () => {
  test("skips inline code, fenced code, URLs, and hidden comments", () => {
    const doc = [
      "A recieve in prose.", //               flagged
      "Inline `recieve` code.", //             skipped — InlineCode
      "Link https://recieve.example/x here.", // skipped — GFM autolink → URL
      "```",
      "recieve fenced", //                     skipped — FencedCode
      "```",
      "{>>recieve hidden<<}", //               skipped — CMComment
    ].join("\n");
    const out = engine.flagged(doc);
    expect(out).toHaveLength(1);
    expect(out[0].lower).toBe("recieve");
    expect(out[0].count).toBe(1); // ONLY the prose occurrence
  });
});

describe("loadSpellEngine — applyReplaceAll()", () => {
  test("replaces every flagged occurrence, preserving case", () => {
    expect(engine.applyReplaceAll("RECIEVE the recieve and Recieve", "recieve", "receive")).toBe(
      "RECEIVE the receive and Receive",
    );
  });

  test("is whole-word — leaves longer tokens that merely contain it", () => {
    // "recieved" is a distinct token (lower !== "recieve") → untouched.
    expect(engine.applyReplaceAll("we recieve what was recieved", "recieve", "receive")).toBe(
      "we receive what was recieved",
    );
  });

  test("does not touch occurrences inside skip regions", () => {
    expect(engine.applyReplaceAll("fix recieve here but not `recieve` in code", "recieve", "receive")).toBe(
      "fix receive here but not `recieve` in code",
    );
  });

  test("no flagged occurrence → text unchanged", () => {
    const doc = "all words are spelled correctly here";
    expect(engine.applyReplaceAll(doc, "recieve", "receive")).toBe(doc);
  });
});

describe("loadSpellEngine — per-doc ignored words", () => {
  test("ignored words are not flagged, but other misspellings still are", () => {
    const e = loadSpellEngine("uk", [], ["fusión", "reo"]);
    const out = e.flagged("the fusión of te reo and a recieve typo").map((w) => w.lower);
    expect(out).not.toContain("fusión");
    expect(out).not.toContain("reo");
    expect(out).toContain("recieve");
  });

  test("ignored words are excluded from replace targets", () => {
    const e = loadSpellEngine("uk", [], ["recieve"]);
    const doc = "we recieve the parcel";
    expect(e.applyReplaceAll(doc, "recieve", "receive")).toBe(doc); // ignored → untouched
  });

  test("ignore does not teach the speller (unlike personal words)", () => {
    // A personal word influences the engine via speller.add; an ignored word must
    // not — the same word stays flagged in a DIFFERENT engine without the ignore.
    const withIgnore = loadSpellEngine("uk", [], ["zyxwv"]);
    expect(withIgnore.flagged("zyxwv")).toEqual([]);
    expect(engine.flagged("zyxwv").map((w) => w.lower)).toContain("zyxwv");
  });
});

describe("loadSpellEngine — suggest()", () => {
  test("returns ranked candidates, capped at 6", () => {
    const s = engine.suggest("recieve");
    expect(s[0]).toBe("receive");
    expect(s.length).toBeLessThanOrEqual(6);
  });
});
