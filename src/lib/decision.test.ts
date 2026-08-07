import { describe, expect, test } from "bun:test";
import { scanTokens } from "./criticmarkup";
import {
  inlineSuggestionDecision,
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
      target: { kind: "suggestion", id: token.id },
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
      target: { kind: "suggestion", id: token.id },
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
      target: { kind: "suggestion", id: token.id },
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
      target: { kind: "suggestion", id: token.id },
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
      target: { kind: "suggestion", id: token.id },
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
      },
      anchor: "old words",
      originalText: "old words",
      proposedText: "new words",
      resultingText: "new words",
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
    });
  });
});
