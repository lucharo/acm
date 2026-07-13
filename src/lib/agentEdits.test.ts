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
  resolveSuggestionGroup,
} from "./agentEdits";
import {
  scanTokens,
  suggestionReplacement,
  suggestionGroupId,
  suggestCards,
} from "./criticmarkup";

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
  test("addSuggestion wraps a span CONTAINING a complete tracked change", () => {
    const doc = "Intro. Writing it was {++genuinely++} hard and rewarding. End.";
    const out = addSuggestion(doc, "was {++genuinely++} hard", "claude", "was hard");
    expect(out).toContain("{==was {++genuinely++} hard==}{>>@claude: SUGGEST: was hard<<}");
    // …and the result is a live, applyable suggestion.
    const [t] = threadsSummary(out);
    expect(t.applicable).toBe(true);
  });
  test("addSuggestion still refuses a span that CUTS a tracked change", () => {
    const doc = "Writing it was {++genuinely++} hard.";
    expect(() => addSuggestion(doc, "was {++genuinely", "claude", "x")).toThrow(AmbiguityError);
  });
});

describe("suggestion groups (#21)", () => {
  // Two related edits, tagged with one group id, in different paragraphs.
  const GDOC =
    "Move the clause: {==delete this here==}{>>@claude: SUGGEST[g:7a]: <<} and then.\n\n" +
    "Land it there: {==old wording==}{>>@claude: SUGGEST[g:7a]: old wording, plus the moved clause<<} done.\n\n" +
    "Unrelated: {==solo span==}{>>@claude: SUGGEST: solo replacement<<} stays.";

  test("the [g:id] tag parses: replacement excludes it, group id extracted", () => {
    expect(suggestionReplacement("SUGGEST[g:7a]: new words")).toBe("new words");
    expect(suggestionGroupId("SUGGEST[g:7a]: new words")).toBe("7a");
    expect(suggestionGroupId("SUGGEST: untagged")).toBeNull();
    expect(suggestionGroupId("a plain comment")).toBeNull();
  });

  test("suggestCards carries groupId + groupSize", () => {
    const sugs = suggestCards(GDOC);
    expect(sugs).toHaveLength(3);
    const grouped = sugs.filter((s) => s.groupId === "7a");
    expect(grouped).toHaveLength(2);
    for (const s of grouped) expect(s.groupSize).toBe(2);
    expect(sugs.find((s) => s.groupId === null)!.groupSize).toBe(1);
  });

  test("accept-all applies every member in one batch; the solo suggestion is untouched", () => {
    const { content, applied, skipped } = resolveSuggestionGroup(GDOC, "7a", "accept");
    expect(applied).toBe(2);
    expect(skipped).toBe(0);
    expect(content).toContain("Move the clause:  and then."); // empty replacement = delete
    expect(content).toContain("Land it there: old wording, plus the moved clause done.");
    expect(content).toContain("{==solo span==}{>>@claude: SUGGEST: solo replacement<<}");
  });

  test("reject-all keeps every original span, drops the group's SUGGEST comments", () => {
    const { content } = resolveSuggestionGroup(GDOC, "7a", "reject");
    expect(content).toContain("Move the clause: delete this here and then.");
    expect(content).toContain("Land it there: old wording done.");
    expect(content).not.toContain("[g:7a]");
  });

  test("two members on ONE thread are contradictory — first wins, second stays pending", () => {
    const doc =
      "x {==span==}{>>@a: SUGGEST[g:z]: first<<}{>>@b: SUGGEST[g:z]: second<<} y";
    const { content, applied, skipped } = resolveSuggestionGroup(doc, "z", "accept");
    expect(applied).toBe(1);
    expect(skipped).toBe(1);
    // The first member's accept keeps the remaining discussion (thread rebuild),
    // so the second suggestion SURVIVES, now anchored on the edited span.
    expect(content).toBe("x {==first==}{>>@b: SUGGEST[g:z]: second<<} y");
  });

  test("unknown / empty group throws", () => {
    expect(() => resolveSuggestionGroup(GDOC, "nope", "accept")).toThrow(AmbiguityError);
  });

  test("addSuggestion --group writes the tagged form", () => {
    const out = addSuggestion("plain prose here", "prose", "claude", "wording", "7a");
    expect(out).toContain("{==prose==}{>>@claude: SUGGEST[g:7a]: wording<<}");
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

  test("anchor uses the same gap-tolerant rule as applicability (stray space)", () => {
    // A space between span and comment must not yield `anchor: null` on a thread
    // that IS applyable — the two fields previously used different adjacency rules.
    const doc = "The {==argument is methodical==} {>>@claude: SUGGEST: argument is systematic<<} here.";
    const [t] = threadsSummary(doc);
    expect(t.applicable).toBe(true);
    expect(t.anchor).toBe("argument is methodical");
  });

  test("anchor resolves when the span wraps tracked changes", () => {
    const doc = "A {==span with {++new++} bits==}{>>@claude: SUGGEST: cleaner span<<} here.";
    const [t] = threadsSummary(doc);
    expect(t.applicable).toBe(true);
    expect(t.anchor).toBe("span with {++new++} bits");
  });
});
