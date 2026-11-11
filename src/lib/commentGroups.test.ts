import { describe, expect, test } from "bun:test";

import { applyRangedEdits, groupThreads, scanTokens, suggestionThreadEdit } from "./criticmarkup";
import {
  noteGroupId,
  noteGroupMembers,
  noteGroupResolveEdits,
  noteText,
  threadEditRequested,
  withNoteGroup,
} from "./commentGroups";
import { isComment } from "./types";
import { addAnchoredComment } from "./agentEdits";

const FACTS =
  "Some {==fact one==}{>>@claude: NOTE[g:facts]: Source A.<<} and " +
  "{==fact two==}{>>@claude: NOTE[g:facts]: Source B.<<}{>>@Luis: thanks<<} and " +
  "{==other==}{>>@claude: plain note<<} end.";

function threadsOf(content: string) {
  return groupThreads(scanTokens(content).filter(isComment), content);
}

describe("note group tags", () => {
  test("reads the group id and the note text, and round-trips an edit", () => {
    expect([noteGroupId("NOTE[g:facts]: Source A."), noteText("NOTE[g:facts]: Source A.")]).toEqual([
      "facts",
      "Source A.",
    ]);
    expect(withNoteGroup("facts", "Source C.")).toBe("NOTE[g:facts]: Source C.");
  });

  test("leaves untagged and SUGGEST bodies alone", () => {
    expect([
      noteGroupId("plain note"),
      noteGroupId("SUGGEST[g:facts]: new"),
      noteText("plain note"),
      withNoteGroup(null, "plain note"),
    ]).toEqual([null, null, "plain note", "plain note"]);
  });
});

describe("noteGroupMembers", () => {
  test("lists each grouped note thread once, in document order, with its span", () => {
    const members = noteGroupMembers(FACTS);

    expect([...members.keys()]).toEqual(["facts"]);
    expect(
      members.get("facts")!.map((m) => ({
        text: m.text,
        anchor: m.anchorText,
        span: FACTS.slice(m.anchorFrom, m.anchorTo),
      })),
    ).toEqual([
      { text: "Source A.", anchor: "fact one", span: "fact one" },
      { text: "Source B.", anchor: "fact two", span: "fact two" },
    ]);
  });
});

describe("notes written by acm comment --group", () => {
  test("join the group the GUI lists", () => {
    let doc = "One claim here. Another claim there.";
    doc = addAnchoredComment(doc, "One claim", "claude", "Source A.", "facts");
    doc = addAnchoredComment(doc, "Another claim", "claude", "Source B.", "facts");

    expect(noteGroupMembers(doc).get("facts")!.map((m) => [m.anchorText, m.text])).toEqual([
      ["One claim", "Source A."],
      ["Another claim", "Source B."],
    ]);
  });
});

describe("noteGroupResolveEdits", () => {
  test("strips every grouped thread with its replies and keeps the rest", () => {
    const { edits, threads, skipped } = noteGroupResolveEdits(FACTS, "facts");

    expect(applyRangedEdits(FACTS, edits)).toBe(
      "Some fact one and fact two and {==other==}{>>@claude: plain note<<} end.",
    );
    expect([threads.length, skipped]).toEqual([2, 0]);
  });

  test("resolves only the ticked notes and leaves the unticked thread open (#25)", () => {
    const sourceA = scanTokens(FACTS).find((t) => isComment(t) && t.body.endsWith("Source A."))!;

    const { edits, threads, skipped } = noteGroupResolveEdits(FACTS, "facts", new Set([sourceA.id]));

    expect(applyRangedEdits(FACTS, edits)).toBe(
      "Some {==fact one==}{>>@claude: NOTE[g:facts]: Source A.<<} and fact two and " +
        "{==other==}{>>@claude: plain note<<} end.",
    );
    expect([threads.length, skipped]).toEqual([1, 0]);
  });

  test("keeps a note thread open when it holds an unticked edit of the group (#25)", () => {
    const content = "A {==one==}{>>@claude: NOTE[g:g1]: why<<}{>>@a: SUGGEST[g:g1]: first<<}.";
    const suggest = scanTokens(content).find((t) => isComment(t) && t.body.startsWith("SUGGEST"))!;

    expect(noteGroupResolveEdits(content, "g1", new Set([suggest.id]))).toEqual({
      edits: [],
      threads: [],
      skipped: 1,
    });
  });

  test("returns no edits for an unknown group", () => {
    expect(noteGroupResolveEdits(FACTS, "nope")).toEqual({ edits: [], threads: [], skipped: 0 });
  });
});

describe("threadEditRequested", () => {
  test("is true while an edit request has no SUGGEST after it", () => {
    const doc = "{==span==}{>>@claude: wordy<<}{>>@Luis: please suggest an edit<<}";
    expect(threadEditRequested(threadsOf(doc)[0])).toBe(true);
  });

  test("clears once an agent answers with a SUGGEST", () => {
    const doc =
      "{==span==}{>>@claude: wordy<<}{>>@Luis: please suggest an edit<<}{>>@claude: SUGGEST: tighter<<}";
    expect(threadEditRequested(threadsOf(doc)[0])).toBe(false);
  });

  test("applying the agent's SUGGEST fulfils the request and keeps the discussion", () => {
    const doc =
      "A {==wordy bit==}{>>@claude: tighten?<<}{>>@You: please suggest an edit<<}{>>@claude: SUGGEST: tight<<} end.";
    const suggest = scanTokens(doc).filter(isComment).at(-1)!;

    const edit = suggestionThreadEdit(doc, suggest, "accept", "keep-discussion")!;
    const after = applyRangedEdits(doc, [edit]);

    expect(after).toBe("A {==tight==}{>>@claude: tighten?<<} end.");
    expect(threadEditRequested(threadsOf(after)[0])).toBe(false);
  });

  test("applying an older SUGGEST keeps a request posted after it", () => {
    const doc =
      "A {==wordy bit==}{>>@claude: SUGGEST: tight<<}{>>@You: please suggest an edit<<} end.";
    const suggest = scanTokens(doc).filter(isComment)[0];

    const after = applyRangedEdits(doc, [suggestionThreadEdit(doc, suggest, "accept", "keep-discussion")!]);

    expect(after).toBe("A {==tight==}{>>@You: please suggest an edit<<} end.");
    expect(threadEditRequested(threadsOf(after)[0])).toBe(true);
  });

  test("rejecting the SUGGEST leaves the request standing for another try", () => {
    const doc =
      "A {==wordy bit==}{>>@claude: tighten?<<}{>>@You: please suggest an edit<<}{>>@claude: SUGGEST: tight<<} end.";
    const suggest = scanTokens(doc).filter(isComment).at(-1)!;

    const after = applyRangedEdits(doc, [suggestionThreadEdit(doc, suggest, "reject", "keep-discussion")!]);

    expect(threadEditRequested(threadsOf(after)[0])).toBe(true);
  });

  test("is false on an ordinary thread", () => {
    expect(threadEditRequested(threadsOf("{==span==}{>>@claude: wordy<<}")[0])).toBe(false);
  });
});
