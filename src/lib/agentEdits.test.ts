import { describe, expect, test } from "bun:test";
import {
  AmbiguityError,
  findThread,
  appendToThread,
  addComment,
  addSuggestion,
  resolveSuggestion,
  resolveThread,
  threadsSummary,
} from "./agentEdits";
import { scanTokens } from "./criticmarkup";

const DOC =
  "Intro. The {==quick brown fox==}{>>@luis: too vivid?<<} jumps. " +
  "A plain sentence about attention and focus here. " +
  "The {==lazy dog==}{>>@luis: define?<<}{>>@maya: agree<<} sleeps. " +
  "And {==a tired claim==}{>>@claude: SUGGEST: a sharper claim<<} ends it.";

describe("findThread — unique match or throw", () => {
  test("finds the one thread containing the phrase", () => {
    const th = findThread(DOC, "too vivid");
    expect(th.comments[0].body).toContain("too vivid");
  });
  test("throws when zero match", () => {
    expect(() => findThread(DOC, "nonexistent phrase")).toThrow(AmbiguityError);
  });
  test("throws when more than one matches", () => {
    // "define" is unique, but a phrase in two threads would throw — craft one:
    const d = "x {==a==}{>>@l: shared word<<} y {==b==}{>>@m: shared word<<} z";
    expect(() => findThread(d, "shared word")).toThrow(AmbiguityError);
  });
});

describe("appendToThread — idempotent reply append", () => {
  test("appends at the thread end, threading the reply", () => {
    const marker = "{>>@claude: yes — tightened<<}";
    const { content, skipped } = appendToThread(DOC, "too vivid", marker);
    expect(skipped).toBe(false);
    // the new comment sits immediately after the matched thread's last comment
    expect(content).toContain("{>>@luis: too vivid?<<}{>>@claude: yes — tightened<<}");
  });
  test("re-running with the same marker is a no-op (idempotent)", () => {
    const marker = "{>>@claude: yes<<}";
    const once = appendToThread(DOC, "too vivid", marker).content;
    const twice = appendToThread(once, "too vivid", marker);
    expect(twice.skipped).toBe(true);
    expect(twice.content).toBe(once);
  });
});

describe("addComment / addSuggestion", () => {
  test("addComment threads a reply by author", () => {
    const out = addComment(DOC, "define?", "claude", "the gap between intent and action");
    expect(out).toContain("{>>@claude: the gap between intent and action<<}");
    // joined onto the @luis/@maya thread (after @maya)
    expect(out).toContain("{>>@maya: agree<<}{>>@claude: the gap between intent and action<<}");
  });
  test("addSuggestion wraps a unique prose span as an anchored SUGGEST", () => {
    const out = addSuggestion(DOC, "attention and focus", "claude", "attention");
    expect(out).toContain("{==attention and focus==}{>>@claude: SUGGEST: attention<<}");
  });
  test("addSuggestion refuses an ambiguous / in-markup span", () => {
    expect(() => addSuggestion(DOC, "The ", "claude", "x")).toThrow(AmbiguityError); // appears twice
    expect(() => addSuggestion(DOC, "quick brown fox", "claude", "x")).toThrow(AmbiguityError); // inside a highlight
  });
});

describe("resolveSuggestion accept/reject", () => {
  test("accept keeps the proposed wording", () => {
    const out = resolveSuggestion(DOC, "a sharper claim", "accept");
    expect(out).toContain("And a sharper claim ends it.");
    expect(out).not.toContain("SUGGEST");
  });
  test("reject keeps the original span", () => {
    const out = resolveSuggestion(DOC, "a sharper claim", "reject");
    expect(out).toContain("And a tired claim ends it.");
    expect(out).not.toContain("SUGGEST");
  });
});

describe("resolveThread", () => {
  test("strips the anchor + comments, keeps the span prose", () => {
    const out = resolveThread(DOC, "define?");
    expect(out).toContain("The lazy dog sleeps.");
    expect(out).not.toContain("@maya");
  });
});

describe("threadsSummary", () => {
  test("summarises anchor, authors, count, applicability", () => {
    const s = threadsSummary(DOC);
    const dog = s.find((t) => t.anchor === "lazy dog")!;
    expect(dog.authors).toEqual(["luis", "maya"]);
    expect(dog.count).toBe(2);
    expect(dog.applicable).toBe(false);
    const sug = s.find((t) => t.anchor === "a tired claim")!;
    expect(sug.applicable).toBe(true); // carries an applyable SUGGEST
  });
});
