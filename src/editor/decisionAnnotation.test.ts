import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import type { DecisionEvent } from "../lib/decision";
import {
  decisionAnnotations,
  decisionEventsFromTransactions,
  decisionHistoryExtension,
  decisionQueueUpdateFromTransactions,
} from "./useCodeMirror";

const event: DecisionEvent = {
  id: "gui-decision-1",
  timestamp: "2026-08-05T10:00:00.000Z",
  action: "accept",
  actor: "Luis",
  source: "gui",
  target: { kind: "suggestion", id: "suggestion-1" },
  anchor: "old",
  originalText: "old",
  proposedText: "new",
  resultingText: "new",
};

test("the document edit and its decision event travel in the same transaction", () => {
  const state = EditorState.create({ doc: "{~~old~>new~~}" });
  const transaction = state.update({
    changes: { from: 0, to: state.doc.length, insert: "new" },
    annotations: decisionAnnotations([event]),
  });

  expect(decisionEventsFromTransactions([transaction])).toEqual([event]);
});

test("ordinary typing carries no decision event", () => {
  const state = EditorState.create({ doc: "old" });
  const transaction = state.update({ changes: { from: 3, insert: "!" } });

  expect(decisionEventsFromTransactions([transaction])).toEqual([]);
});

test("undo cancels an unpersisted decision and redo restores the same event", () => {
  let state = EditorState.create({
    doc: "{~~old~>new~~}",
    extensions: [history(), decisionHistoryExtension],
  });
  const applied = state.update({
    changes: { from: 0, to: state.doc.length, insert: "new" },
    annotations: decisionAnnotations([event]),
  });
  state = applied.state;
  let observed = applied;
  const target = {
    get state() {
      return state;
    },
    dispatch(transaction: typeof applied) {
      observed = transaction;
      state = transaction.state;
    },
  };

  expect(decisionQueueUpdateFromTransactions([applied])).toEqual({
    enqueue: [event],
    cancel: [],
  });
  expect(undo(target)).toBe(true);
  expect(decisionQueueUpdateFromTransactions([observed])).toEqual({
    enqueue: [],
    cancel: [event],
  });
  expect(redo(target)).toBe(true);
  expect(decisionQueueUpdateFromTransactions([observed])).toEqual({
    enqueue: [event],
    cancel: [],
  });
});
