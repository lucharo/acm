import { describe, expect, test } from "bun:test";

import { scanTokens, suggestionThreadEdit } from "./criticmarkup";
import { inlineSuggestionDecision, structuredSuggestionDecision } from "./decision";
import {
  applyProvenanceChange,
  baselineProvenance,
  provenanceForRange,
  type ProvenanceAttribution,
} from "./provenance";

const unknown: ProvenanceAttribution = {
  author: "Unknown",
  source: "baseline",
  timestamp: "2026-08-12T10:00:00.000Z",
};
const luis: ProvenanceAttribution = {
  author: "Luis",
  source: "human",
  timestamp: "2026-08-12T10:01:00.000Z",
};
const claude: ProvenanceAttribution = {
  author: "Claude",
  source: "agent",
  timestamp: "2026-08-12T10:00:30.000Z",
};
const codex: ProvenanceAttribution = {
  author: "Codex",
  source: "agent",
  timestamp: "2026-08-12T10:00:45.000Z",
};

describe("range provenance", () => {
  test("attributes only a changed range and preserves both unchanged sides", () => {
    const before = "Alpha beta gamma";
    const after = "Alpha BETA gamma";

    expect(applyProvenanceChange(before, after, baselineProvenance(before, unknown), luis)).toEqual([
      { from: 0, to: 6, ...unknown },
      { from: 6, to: 10, ...luis },
      { from: 10, to: after.length, ...unknown },
    ]);
  });

  test("keeps independent authors across separated edits", () => {
    const first = "one two three";
    const second = "ONE two THREE";
    const segments = applyProvenanceChange(
      first,
      second,
      baselineProvenance(first, unknown),
      luis,
    );

    expect(provenanceForRange(segments, 0, second.length).map((segment) => ({
      text: second.slice(segment.from, segment.to),
      author: segment.author,
    }))).toEqual([
      { text: "ONE", author: "Luis" },
      { text: " two ", author: "Unknown" },
      { text: "THREE", author: "Luis" },
    ]);
  });

  test("accepted suggestion text belongs to the proposer and records the reviewer", () => {
    const before = "old wording";
    const after = "new wording";
    const segments = applyProvenanceChange(
      before,
      after,
      baselineProvenance(before, unknown),
      luis,
      [
        {
          id: "decision-1",
          timestamp: "2026-08-12T10:02:00.000Z",
          action: "apply",
          actor: "Luis",
          source: "gui",
          target: { kind: "suggestion", id: "suggestion-1" },
          anchor: "old wording",
          originalText: "old wording",
          proposedText: "new wording",
          resultingText: "new wording",
          proposer: "Claude",
        },
      ],
    );

    expect(segments).toEqual([
      {
        from: 0,
        to: after.length,
        author: "Claude",
        source: "suggestion",
        timestamp: "2026-08-12T10:02:00.000Z",
        reviewedBy: "Luis",
        decisionId: "decision-1",
      },
    ]);
  });

  test("accepted native suggestion text records its original author and reviewer", () => {
    const before = "A {++fresh++} ending";
    const after = "A fresh ending";
    const token = scanTokens(before)[0];
    if (!token || token.type !== "insert") throw new Error("expected an insertion");
    const current = [
      { from: 0, to: token.from, ...unknown },
      { from: token.from, to: token.to, ...claude },
      { from: token.to, to: before.length, ...unknown },
    ];
    const decision = inlineSuggestionDecision(token, "accept", "Luis", "gui");

    const segments = applyProvenanceChange(before, after, current, luis, [decision]);

    expect(provenanceForRange(segments, 2, 7)).toEqual([
      {
        from: 2,
        to: 7,
        author: "Claude",
        source: "suggestion",
        timestamp: decision.timestamp,
        reviewedBy: "Luis",
        decisionId: decision.id,
      },
    ]);
  });

  test("accepted native suggestion preserves mixed proposal authorship", () => {
    const before = "A {++fresh++} ending";
    const after = "A fresh ending";
    const token = scanTokens(before)[0];
    if (!token || token.type !== "insert") throw new Error("expected an insertion");
    const innerFrom = token.from + 3;
    const current = [
      { from: 0, to: innerFrom, ...unknown },
      { from: innerFrom, to: innerFrom + 2, ...claude },
      { from: innerFrom + 2, to: innerFrom + 5, ...codex },
      { from: innerFrom + 5, to: before.length, ...unknown },
    ];
    const decision = inlineSuggestionDecision(token, "accept", "Luis", "gui");

    const segments = applyProvenanceChange(before, after, current, luis, [decision]);

    expect(provenanceForRange(segments, 2, 7).map((segment) => ({
      from: segment.from,
      to: segment.to,
      author: segment.author,
      source: segment.source,
      reviewedBy: segment.reviewedBy,
      decisionId: segment.decisionId,
    }))).toEqual([
      { from: 2, to: 4, author: "Claude", source: "suggestion", reviewedBy: "Luis", decisionId: decision.id },
      { from: 4, to: 7, author: "Codex", source: "suggestion", reviewedBy: "Luis", decisionId: decision.id },
    ]);
  });

  test("accepted structured suggestion uses its exact repeated-text anchor", () => {
    const before = "old and {==old==}{>>@Claude: SUGGEST: new<<} then new";
    const comment = scanTokens(before).find((token) => token.type === "comment");
    if (!comment || comment.type !== "comment") throw new Error("expected a comment");
    const edit = suggestionThreadEdit(before, comment, "accept");
    if (!edit) throw new Error("expected a suggestion edit");
    const after = before.slice(0, edit.from) + edit.insert + before.slice(edit.to);
    const decision = structuredSuggestionDecision(
      before,
      comment,
      "accept",
      "apply",
      "Luis",
      "gui",
    );
    if (!decision) throw new Error("expected a decision");

    const segments = applyProvenanceChange(
      before,
      after,
      baselineProvenance(before, unknown),
      luis,
      [decision],
    );
    const acceptedFrom = after.indexOf("new");

    expect(provenanceForRange(segments, acceptedFrom, acceptedFrom + 3)).toEqual([
      {
        from: acceptedFrom,
        to: acceptedFrom + 3,
        author: "Claude",
        source: "suggestion",
        timestamp: decision.timestamp,
        reviewedBy: "Luis",
        decisionId: decision.id,
      },
    ]);
  });
});
