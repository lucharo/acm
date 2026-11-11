import { describe, expect, test } from "bun:test";
import { scanTokens, suggestionGroupEdits } from "./criticmarkup";
import {
  inlineSuggestionDecision,
  rebaseDecisionEventsAfterChange,
  rebaseDecisionEventsForCommit,
  structuredSuggestionDecision,
  structuredSuggestionGroupDecisions,
} from "./decision";
import type { CommentToken, SuggestionToken } from "./types";

function suggestion(markup: string): SuggestionToken {
  const token = scanTokens(markup)[0];
  if (!token || (token.type !== "insert" && token.type !== "delete" && token.type !== "substitute")) {
    throw new Error("expected one suggestion token");
  }
  return token;
}

describe("inline suggestion decision events", () => {
  test("a blank GUI author falls back to an inspectable actor", () => {
    const token = suggestion("{++new words++}");

    const event = inlineSuggestionDecision(token, "accept", "   ", "gui");

    expect(event).toEqual({
      id: expect.any(String),
      timestamp: expect.any(String),
      action: "accept",
      actor: "You",
      source: "gui",
      target: {
        kind: "suggestion",
        id: token.id,
        beforeFrom: 0,
        beforeTo: token.to,
        afterFrom: 0,
        afterTo: 9,
      },
      anchor: "new words",
      originalText: "",
      proposedText: "new words",
      resultingText: "new words",
    });
  });

  test("a blank CLI author falls back to an inspectable actor", () => {
    const token = suggestion("{--old words--}");

    const event = inlineSuggestionDecision(token, "reject", "", "cli");

    expect(event).toEqual({
      id: expect.any(String),
      timestamp: expect.any(String),
      action: "reject",
      actor: "acm-cli",
      source: "cli",
      target: {
        kind: "suggestion",
        id: token.id,
        beforeFrom: 0,
        beforeTo: token.to,
        afterFrom: 0,
        afterTo: 9,
      },
      anchor: "old words",
      originalText: "old words",
      proposedText: "",
      resultingText: "old words",
    });
  });

  test("accepting an insertion records empty original text and the inserted result", () => {
    const token = suggestion("{++new words++}");

    const event = inlineSuggestionDecision(token, "accept", "Luis", "gui");

    expect(event).toEqual({
      id: expect.any(String),
      timestamp: expect.any(String),
      action: "accept",
      actor: "Luis",
      source: "gui",
      target: {
        kind: "suggestion",
        id: token.id,
        beforeFrom: 0,
        beforeTo: token.to,
        afterFrom: 0,
        afterTo: 9,
      },
      anchor: "new words",
      originalText: "",
      proposedText: "new words",
      resultingText: "new words",
    });
  });

  test("rejecting a deletion records that the original text remains", () => {
    const token = suggestion("{--old words--}");

    const event = inlineSuggestionDecision(token, "reject", "Luis", "gui");

    expect(event).toEqual({
      id: expect.any(String),
      timestamp: expect.any(String),
      action: "reject",
      actor: "Luis",
      source: "gui",
      target: {
        kind: "suggestion",
        id: token.id,
        beforeFrom: 0,
        beforeTo: token.to,
        afterFrom: 0,
        afterTo: 9,
      },
      anchor: "old words",
      originalText: "old words",
      proposedText: "",
      resultingText: "old words",
    });
  });

  test("accepting a substitution records both sides and the replacement result", () => {
    const token = suggestion("{~~old words~>new words~~}");

    const event = inlineSuggestionDecision(token, "accept", "Luis", "gui");

    expect(event).toEqual({
      id: expect.any(String),
      timestamp: expect.any(String),
      action: "accept",
      actor: "Luis",
      source: "gui",
      target: {
        kind: "suggestion",
        id: token.id,
        beforeFrom: 0,
        beforeTo: token.to,
        afterFrom: 0,
        afterTo: 9,
      },
      anchor: "old words",
      originalText: "old words",
      proposedText: "new words",
      resultingText: "new words",
    });
  });
});

describe("structured suggestion decision events", () => {
  test("Apply & resolve records the combined action and complete affected identity", () => {
    const content =
      "Pay {==old words==}{>>@a: context<<}{>>@b: SUGGEST[g:copy]: new words<<}{>>@c: follow-up<<}.";
    const comment = scanTokens(content).find(
      (token): token is CommentToken => token.type === "comment" && token.body.includes("SUGGEST"),
    )!;

    const event = structuredSuggestionDecision(
      content,
      comment,
      "accept",
      "apply-resolve",
      "Luis",
      "gui",
    );

    expect(event).toEqual({
      id: expect.any(String),
      timestamp: expect.any(String),
      action: "apply-resolve",
      actor: "Luis",
      source: "gui",
      target: {
        kind: "suggestion",
        id: comment.id,
        threadId: expect.any(String),
        groupId: "copy",
        beforeFrom: 4,
        beforeTo: content.length - 1,
        afterFrom: 4,
        afterTo: 13,
      },
      anchor: "old words",
      originalText: "old words",
      proposedText: "new words",
      resultingText: "new words",
      proposer: "b",
    });
  });

  test("a conflicting Apply & resolve group emits no ghost event", () => {
    const content =
      "A {==one==}{>>@a: SUGGEST[g:g1]: first<<}{>>@b: SUGGEST[g:g1]: alternative<<}.";

    const events = structuredSuggestionGroupDecisions(
      content,
      "g1",
      "accept",
      "apply-resolve",
      "Luis",
      "gui",
    );

    expect(events).toEqual([]);
  });

  test("identical competing group suggestions consume one planned edit once", () => {
    const content =
      "A {==one==}{>>@a: SUGGEST[g:g1]: same<<}{>>@a: SUGGEST[g:g1]: same<<}.";

    const events = structuredSuggestionGroupDecisions(
      content,
      "g1",
      "accept",
      "apply",
      "Luis",
      "gui",
    );

    expect(events).toHaveLength(1);
    expect(events[0].target).toEqual({
      kind: "suggestion",
      id: expect.any(String),
      threadId: expect.any(String),
      groupId: "g1",
      beforeFrom: 2,
      beforeTo: content.length - 1,
      afterFrom: 5,
      afterTo: 9,
    });
  });

  test("group decision result ranges use final document coordinates", () => {
    const content =
      "A {==one==}{>>@a: SUGGEST[g:g1]: first<<} and {==two==}{>>@b: SUGGEST[g:g1]: second longer<<}.";
    const { edits } = suggestionGroupEdits(content, "g1", "accept");
    let after = content;
    for (const edit of [...edits].reverse()) {
      after = after.slice(0, edit.from) + edit.insert + after.slice(edit.to);
    }

    const events = structuredSuggestionGroupDecisions(
      content,
      "g1",
      "accept",
      "apply",
      "Luis",
      "gui",
    );

    expect(events).toHaveLength(2);
    expect(events.map((event) => after.slice(event.target.afterFrom, event.target.afterTo))).toEqual([
      "first",
      "second longer",
    ]);
  });
});

describe("group decisions for a ticked subset (#25)", () => {
  test("record only the ticked members, at their final positions", () => {
    const content =
      "A {==one==}{>>@a: SUGGEST[g:g1]: first<<} B {==two==}{>>@b: SUGGEST[g:g1]: second<<} " +
      "C {==three==}{>>@c: SUGGEST[g:g1]: third longer<<}.";
    const comments = scanTokens(content).filter((t): t is CommentToken => t.type === "comment");
    const only = new Set([comments[0].id, comments[2].id]);
    const { edits } = suggestionGroupEdits(content, "g1", "accept", "keep-discussion", only);
    let after = content;
    for (const edit of [...edits].reverse()) {
      after = after.slice(0, edit.from) + edit.insert + after.slice(edit.to);
    }

    const events = structuredSuggestionGroupDecisions(
      content,
      "g1",
      "accept",
      "apply",
      "Luis",
      "gui",
      only,
    );

    expect(events.map((event) => event.target.id)).toEqual([comments[0].id, comments[2].id]);
    expect(events.map((event) => after.slice(event.target.afterFrom, event.target.afterTo))).toEqual([
      "first",
      "third longer",
    ]);
  });

  test("of two identical competing members, the event names the ticked one", () => {
    const content = "A {==one==}{>>@a: SUGGEST[g:g1]: same<<}{>>@a: SUGGEST[g:g1]: same<<}.";
    const comments = scanTokens(content).filter((t): t is CommentToken => t.type === "comment");
    const only = new Set([comments[1].id]);

    const events = structuredSuggestionGroupDecisions(content, "g1", "accept", "apply", "Luis", "gui", only);

    expect(events.map((event) => event.target.id)).toEqual([comments[1].id]);
  });
});

describe("decision range rebasing", () => {
  test("later local typing and a server merge move the persisted result range", () => {
    const base = "Header\n{~~old~>new~~}\nnew\n";
    const token = suggestion("{~~old~>new~~}");
    const event = {
      ...inlineSuggestionDecision(token, "accept", "Luis", "gui"),
      target: {
        ...inlineSuggestionDecision(token, "accept", "Luis", "gui").target,
        beforeFrom: "Header\n".length,
        beforeTo: "Header\n".length + token.to,
        afterFrom: "Header\n".length,
        afterTo: "Header\nnew".length,
      },
      proposer: "Claude",
    };
    const immediate = "Header\nnew\nnew\n";
    const mine = "Local note\n" + immediate;
    const theirs = "Agent note\n" + base;
    const committed = "Agent note\n" + mine;
    const [locallyRebased] = rebaseDecisionEventsAfterChange([event], immediate, mine);

    const [rebased] = rebaseDecisionEventsForCommit(
      [locallyRebased],
      { base, mine, theirs, committed },
    );

    const expectedFrom = committed.indexOf("new");
    expect(rebased.target.afterFrom).toBe(expectedFrom);
    expect(rebased.target.afterTo).toBe(expectedFrom + 3);
    expect(committed.slice(rebased.target.afterFrom, rebased.target.afterTo)).toBe("new");
  });
});
