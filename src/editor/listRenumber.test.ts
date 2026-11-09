import { describe, expect, test } from "bun:test";
import { history, undo, redo, moveLineUp } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";

import { Annotation } from "@codemirror/state";
import { listRenumber } from "./listRenumber";
import {
  decisionAnnotation,
  decisionAnnotations,
  decisionHistoryExtension,
  decisionQueueUpdateFromTransactions,
} from "./useCodeMirror";
import { inlineSuggestionDecision } from "../lib/decision";
import { applySuggestion, scanTokens } from "../lib/criticmarkup";
import type { SuggestionToken } from "../lib/criticmarkup";

const decision = Annotation.define<boolean>();
const isDecision = (tr: Transaction) => tr.annotation(decision) === true;

function editor(doc: string) {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage }), history(), listRenumber(isDecision)],
  });
}

function lineRange(doc: string, text: string) {
  const from = doc.indexOf(text);
  const to = doc.indexOf("\n", from) + 1;
  return { from, to };
}

function deleteLine(doc: string, text: string): string {
  const state = editor(doc);
  const { from, to } = lineRange(doc, text);
  return state.update({ changes: { from, to }, userEvent: "delete.selection" }).state.doc.toString();
}

/** The editor's real history, decision and renumber wiring. EditorView needs a
 * DOM, so a stub holds the state and feeds each transaction to the real update
 * listeners, as the view does. */
function reviewEditor(doc: string) {
  const view = {
    transactions: [] as Transaction[],
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        decisionHistoryExtension,
        listRenumber((tr) => tr.annotation(decisionAnnotation) !== undefined),
      ],
    }),
    dispatch(spec: Transaction | TransactionSpec) {
      const tr = spec instanceof Transaction ? spec : view.state.update(spec);
      view.state = tr.state;
      view.transactions.push(tr);
      const update = {
        view,
        state: tr.state,
        startState: tr.startState,
        changes: tr.changes,
        docChanged: tr.docChanged,
        transactions: [tr],
      } as unknown as ViewUpdate;
      for (const listener of tr.state.facet(EditorView.updateListener)) listener(update);
    },
  };
  return view;
}

/** Accept the suggestion through the path App.tsx uses, then let the queued
 * relabelling run. */
async function acceptInsertion(view: ReturnType<typeof reviewEditor>, raw: string, insert: string) {
  const from = view.state.doc.toString().indexOf(raw);
  view.dispatch({
    changes: { from, to: from + raw.length, insert },
    annotations: decisionAnnotations([]),
  });
  await Promise.resolve();
}

describe("ordered list renumbering (#80)", () => {
  test("deleting a numbered item renumbers the items after it", () => {
    expect(deleteLine("1. one\n2. two\n3. three\n4. four\n", "2. two")).toBe(
      "1. one\n2. three\n3. four\n",
    );
  });

  test("deleting the first item keeps the list starting at its old start", () => {
    expect(deleteLine("1. one\n2. two\n3. three\n", "1. one")).toBe("1. two\n2. three\n");
  });

  test("lettered and roman lists keep their style, upper and lower case", () => {
    expect(deleteLine("a. one\nb. two\nc. three\n", "a. one")).toBe("a. two\nb. three\n");
    expect(deleteLine("A) one\nB) two\nC) three\n", "B) two")).toBe("A) one\nB) three\n");
    expect(deleteLine("i. one\nii. two\niii. three\niv. four\n", "i. one")).toBe(
      "i. two\nii. three\niii. four\n",
    );
    expect(deleteLine("I. one\nII. two\nIII. three\n", "II. two")).toBe("I. one\nII. three\n");
  });

  test("each nesting level is renumbered on its own", () => {
    const doc = "1. one\n2. two\n   a. alpha\n   b. beta\n   c. gamma\n3. three\n";

    expect(deleteLine(doc, "   a. alpha")).toBe(
      "1. one\n2. two\n   a. beta\n   b. gamma\n3. three\n",
    );
    expect(deleteLine(doc, "1. one")).toBe(
      "1. two\n   a. alpha\n   b. beta\n   c. gamma\n2. three\n",
    );
  });

  test("moving an item up renumbers both items", () => {
    const doc = "1. one\n2. two\n3. three\n";
    let state = editor(doc);
    state = state.update({ selection: EditorSelection.cursor(doc.indexOf("three")) }).state;
    moveLineUp({ state, dispatch: (tr) => (state = tr.state) });

    expect(state.doc.toString()).toBe("1. one\n2. three\n3. two\n");
  });

  test("inserting an item in the middle renumbers the items after it", () => {
    const doc = "1. one\n2. two\n";
    const state = editor(doc);
    const at = doc.indexOf("2. two");

    const next = state.update({ changes: { from: at, insert: "2. new\n" }, userEvent: "input.paste" });

    expect(next.state.doc.toString()).toBe("1. one\n2. new\n3. two\n");
  });

  test("accepting a suggested item (a plain local edit) renumbers the list", () => {
    const doc = "1. one\n{++2. new\n++}2. two\n";
    const state = editor(doc);
    const from = doc.indexOf("{++");
    const close = doc.indexOf("++}");

    const accepted = state.update({
      changes: [
        { from, to: from + 3 },
        { from: close, to: close + 3 },
      ],
    });

    expect(accepted.state.doc.toString()).toBe("1. one\n2. new\n3. two\n");
  });

  test("typing a new first label sets where the list starts", () => {
    const doc = "1. one\n2. two\n";
    const state = editor(doc);

    const typed = state.update({ changes: { from: 0, to: 1, insert: "5" }, userEvent: "input.type" });

    expect(typed.state.doc.toString()).toBe("5. one\n6. two\n");
  });

  test("one undo restores the deleted item and the old labels", () => {
    const doc = "1. one\n2. two\n3. three\n";
    let state = editor(doc);
    const { from, to } = lineRange(doc, "1. one");
    state = state.update({ changes: { from, to }, userEvent: "delete.selection" }).state;
    undo({ state, dispatch: (tr) => (state = tr.state) });

    expect(state.doc.toString()).toBe(doc);
  });

  test("undo restores a list that was inconsistent to begin with exactly", () => {
    const doc = "1. one\n1. two\n1. three\n";
    let state = editor(doc);
    const { from, to } = lineRange(doc, "1. one");
    state = state.update({ changes: { from, to }, userEvent: "delete.selection" }).state;
    expect(state.doc.toString()).toBe("1. two\n2. three\n");

    undo({ state, dispatch: (tr) => (state = tr.state) });

    expect(state.doc.toString()).toBe(doc);
  });

  test("a paragraph between two lists keeps them separate", () => {
    const doc = "1. one\n2. two\n3. three\n\nA paragraph.\n\n1. four\n2. five\n";

    expect(deleteLine(doc, "2. two")).toBe(
      "1. one\n2. three\n\nA paragraph.\n\n1. four\n2. five\n",
    );
  });

  test("numbered lines inside a multi-line comment are not list items", () => {
    const doc = "1. one\n{>>@A:\n1. note\n3. note\n<<}\n2. two\n3. three\n";
    expect(deleteLine(doc, "2. two")).toBe("1. one\n{>>@A:\n1. note\n3. note\n<<}\n2. three\n");

    const at = doc.indexOf("3. note") + "3. note".length;
    const typed = editor(doc).update({ changes: { from: at, insert: "s" }, userEvent: "input.type" });
    expect(typed.state.doc.toString()).toBe(doc.replace("3. note", "3. notes"));
  });

  test("a heading or bullet right after an item ends the list", () => {
    const heading = "1. one\n2. two\n# Heading\n1. three\n2. four\n";
    expect(deleteLine(heading, "2. two")).toBe("1. one\n# Heading\n1. three\n2. four\n");

    const bullet = "1. one\n2. two\n- bullet\n1. three\n2. four\n";
    expect(deleteLine(bullet, "2. two")).toBe("1. one\n- bullet\n1. three\n2. four\n");
  });

  test("long roman labels and roman runs that do not start at i", () => {
    expect(deleteLine("xvii. a\nxviii. b\nxix. c\nxx. d\n", "xviii. b")).toBe(
      "xvii. a\nxviii. c\nxix. d\n",
    );
    expect(deleteLine("v. a\nvi. b\nvii. c\n", "vi. b")).toBe("v. a\nvi. c\n");
  });

  test("a word followed by a full stop is not a list label", () => {
    expect(deleteLine("Note. first\nAlso. second\nThen. third\n", "Also. second")).toBe(
      "Note. first\nThen. third\n",
    );
    expect(deleteLine("dim. one\nmid. two\nlid. three\n", "mid. two")).toBe(
      "dim. one\nlid. three\n",
    );
  });

  test("single letters that are roman digits stay alphabetic unless the list starts at i", () => {
    expect(deleteLine("c. one\nd. two\nd. three\n", "d. two")).toBe("c. one\nd. three\n");
    expect(deleteLine("i. one\nv. two\nx. three\n", "v. two")).toBe("i. one\nii. three\n");
  });

  test("deleting the first label's leading digit sets the new start", () => {
    const doc = "15. first\n16. second\n";
    const state = editor(doc);

    const next = state.update({ changes: { from: 0, to: 1 }, userEvent: "delete.backward" });

    expect(next.state.doc.toString()).toBe("5. first\n6. second\n");
  });

  test("a list beyond the parsed part of a large document is left alone", () => {
    const filler = "Some prose line that is not a list.\n\n".repeat(40_000);
    const doc = `${filler}\`\`\`\n1. one\n2. two\n3. three\n\`\`\`\n`;

    expect(deleteLine(doc, "2. two").endsWith("```\n1. one\n3. three\n```\n")).toBe(true);
  });

  test("a multi-line comment inserted between items leaves the list as it is", () => {
    const doc = "1. one\n2. two\n3. three\n";
    const at = doc.indexOf("2. two");

    const next = editor(doc).update({ changes: { from: at, insert: "{>>@A:\na note\n<<}\n" }, userEvent: "input.paste" });

    expect(next.state.doc.toString()).toBe("1. one\n{>>@A:\na note\n<<}\n2. two\n3. three\n");
  });

  test("a thematic break ends the list", () => {
    for (const rule of ["***", "---", "___"]) {
      const doc = `1. one\n2. two\n${rule}\n1. three\n2. four\n`;
      expect(deleteLine(doc, "2. two")).toBe(`1. one\n${rule}\n1. three\n2. four\n`);
    }
  });

  test("a pasted list keeps its own numbering", () => {
    const doc = "5. five\n6. six\n";
    const pasted = "1. new\n2. newer\n\nParagraph.\n\n";

    const next = editor(doc).update({ changes: { from: 0, insert: pasted }, userEvent: "input.paste" });

    expect(next.state.doc.toString()).toBe(pasted + doc);
  });

  test("a lettered list that would run past z is left alone", () => {
    const doc = "y. one\nz. two\n";
    const next = editor(doc).update({ changes: { from: doc.length, insert: "z. three\n" }, userEvent: "input.paste" });

    expect(next.state.doc.toString()).toBe("y. one\nz. two\nz. three\n");
  });

  test("a list with an item wrapped in review markup is left alone until it is resolved", () => {
    const doc = "1. one\n2. two\n3. three\n";
    const at = doc.indexOf("2. two");
    const wrapped = editor(doc).update({
      changes: [
        { from: at, insert: "{==" },
        { from: at + "2. two".length, insert: "==}{>>@A: why?<<}" },
      ],
      userEvent: "input",
    });
    expect(wrapped.state.doc.toString()).toBe("1. one\n{==2. two==}{>>@A: why?<<}\n3. three\n");

    const proposal = "1. one\n{++2. new\n3. newer++}\n2. two\n3. three\n";
    const at2 = proposal.indexOf("one") + 3;
    const typed = editor(proposal).update({ changes: { from: at2, insert: "!" }, userEvent: "input.type" });
    expect(typed.state.doc.toString()).toBe(proposal.replace("one", "one!"));
  });

  test("numbered lines in an HTML comment, and an HTML block after a list, are respected", () => {
    const comment = "1. one\n2. two\n3. three\n\n<!--\n1. note\n3. note\n-->\n";
    expect(deleteLine(comment, "2. two")).toBe("1. one\n2. three\n\n<!--\n1. note\n3. note\n-->\n");
    const inside = comment.indexOf("3. note") + "3. note".length;
    const typed = editor(comment).update({ changes: { from: inside, insert: "s" }, userEvent: "input.type" });
    expect(typed.state.doc.toString()).toBe(comment.replace("3. note", "3. notes"));

    const html = "1. one\n2. two\n<div>box</div>\n\n1. three\n2. four\n";
    expect(deleteLine(html, "2. two")).toBe("1. one\n<div>box</div>\n\n1. three\n2. four\n");
  });

  test("a label that would change width under nested content is left alone", () => {
    const doc = "8. eight\n9. nine\n   1. child\n";
    const next = editor(doc).update({ changes: { from: 0, insert: "8. new\n" }, userEvent: "input.paste" });

    expect(next.state.doc.toString()).toBe("8. new\n8. eight\n9. nine\n   1. child\n");
  });

  test("a tab and four spaces are the same nesting level", () => {
    const doc = "1. parent\n\t1. first\n    2. second\n    3. third\n";

    expect(deleteLine(doc, "\t1. first")).toBe("1. parent\n    1. second\n    2. third\n");
  });

  test("a list whose first item is wrapped in review markup is left alone", () => {
    const doc = "{==1. one==}{>>@A: why?<<}\n2. two\n3. three\n4. four\n";

    expect(deleteLine(doc, "3. three")).toBe("{==1. one==}{>>@A: why?<<}\n2. two\n4. four\n");
  });

  test("pasting a new first label sets where the list starts", () => {
    const next = editor("1. one\n2. two\n").update({ changes: { from: 0, to: 1, insert: "5" }, userEvent: "input.paste" });

    expect(next.state.doc.toString()).toBe("5. one\n6. two\n");

    const item = editor("1. one\n2. two\n").update({ changes: { from: 0, insert: "0. zero\n" }, userEvent: "input.paste" });
    expect(item.state.doc.toString()).toBe("1. zero\n2. one\n3. two\n");
  });

  test("long roman labels are read as labels", () => {
    expect(deleteLine("cclxxxvii. a\ncclxxxviii. b\ncclxxxix. c\nccxc. d\n", "cclxxxvii. a")).toBe(
      "cclxxxvii. b\ncclxxxviii. c\ncclxxxix. d\n",
    );
  });

  test("a review decision's own transaction is never widened by renumbering", () => {
    const doc = "1. one\n2. two\n3. three\n";
    const { from, to } = lineRange(doc, "2. two");

    const accepted = editor(doc).update({ changes: { from, to }, annotations: decision.of(true) });

    // The renumbering follows in its own transaction, dispatched by the view.
    expect(accepted.state.doc.toString()).toBe("1. one\n3. three\n");
  });

  test("one undo of an accepted item restores the suggestion and every label", async () => {
    const doc = "1. one\n{++2. new++}\n2. two";
    const view = reviewEditor(doc);
    await acceptInsertion(view, "{++2. new++}", "2. new");
    expect(view.state.doc.toString()).toBe("1. one\n2. new\n3. two");

    undo(view);

    expect(view.state.doc.toString()).toBe(doc);
  });

  /** Accept the document's substitution with a real audit event, then let the
   * queued relabelling run. */
  async function acceptWithAudit(doc: string) {
    const view = reviewEditor(doc);
    const token = scanTokens(doc)[0] as SuggestionToken;
    const event = inlineSuggestionDecision(token, "accept", "Luis", "gui");
    view.dispatch({
      changes: { from: token.from, to: token.to, insert: applySuggestion(doc.slice(token.from, token.to), "accept") },
      annotations: decisionAnnotations([event]),
    });
    await Promise.resolve();
    return { view, event };
  }

  test("accepting the deletion of a nested first item renumbers its siblings from that start", async () => {
    const { view } = await acceptWithAudit("1. parent\n   {--\n   1. a\n   --}\n   2. b\n   3. c");

    expect(view.state.doc.toString()).toBe("1. parent\n   \n   1. b\n   2. c");
  });

  test("redo requeues a decision at the range the relabelling moved it to", async () => {
    const { view, event } = await acceptWithAudit("9. nine\n9. ten\n11. {~~old~>new~~}");
    undo(view);

    redo(view);

    expect(view.state.doc.toString()).toBe("9. nine\n10. ten\n11. new");
    expect(decisionQueueUpdateFromTransactions([view.transactions.at(-1)!])).toEqual({
      enqueue: [{ ...event, target: { ...event.target, afterFrom: 20, afterTo: 23 } }],
      cancel: [],
    });
  });

  test("redo keeps a decision's range when the relabelled lines repeat each other", async () => {
    const { view, event } = await acceptWithAudit("1. x\n1. x\n2. {~~a~>x~~}\nend");
    undo(view);

    redo(view);

    expect(view.state.doc.toString()).toBe("1. x\n2. x\n3. x\nend");
    expect(decisionQueueUpdateFromTransactions([view.transactions.at(-1)!])).toEqual({
      enqueue: [event],
      cancel: [],
    });
  });

  test("a second undo and redo does not move the requeued decision again", async () => {
    const { view, event } = await acceptWithAudit("9. nine\n9. ten\n11. {~~old~>new~~}");
    undo(view);
    redo(view);
    undo(view);

    redo(view);

    expect(decisionQueueUpdateFromTransactions([view.transactions.at(-1)!])).toEqual({
      enqueue: [{ ...event, target: { ...event.target, afterFrom: 20, afterTo: 23 } }],
      cancel: [],
    });
  });

  test("redo after undoing an accepted item brings back the renumbered list", async () => {
    const view = reviewEditor("1. one\n{++2. new++}\n2. two");
    await acceptInsertion(view, "{++2. new++}", "2. new");
    undo(view);

    redo(view);

    expect(view.state.doc.toString()).toBe("1. one\n2. new\n3. two");
  });

  test("an edit straight after the relabelling is its own undo step", async () => {
    const doc = "1. one\n{++2. new++}\n2. two";
    const view = reviewEditor(doc);
    await acceptInsertion(view, "{++2. new++}", "2. new");
    // Right after the relabelled "3", so it would group with that change if it could.
    view.dispatch({ changes: { from: view.state.doc.toString().indexOf("3") + 1, insert: "x" } });

    undo(view);

    expect(view.state.doc.toString()).toBe("1. one\n2. new\n3. two");
  });

  test("adjacent typing still groups into one undo step", () => {
    const view = reviewEditor("start");
    view.dispatch({ changes: { from: 5, insert: "a" }, userEvent: "input.type" });
    view.dispatch({ changes: { from: 6, insert: "b" }, userEvent: "input.type" });

    undo(view);

    expect(view.state.doc.toString()).toBe("start");
  });

  test("a comment at the very start of an item's line holds the list", () => {
    const doc = "1. one\n{>>note<<}2. two\n3. three";

    expect(deleteLine(doc, "1. one")).toBe("{>>note<<}2. two\n3. three");
  });

  test("a thread of comments at the very start of an item's line holds the list", () => {
    const doc = "1. one\n{>>note<<}{>>reply<<}2. two\n3. three";

    expect(deleteLine(doc, "1. one")).toBe("{>>note<<}{>>reply<<}2. two\n3. three");
  });

  test("a thread of comments separated by a space at the start of an item's line holds the list", () => {
    const doc = "1. one\n{>>note<<} {>>reply<<}2. two\n3. three";

    expect(deleteLine(doc, "1. one")).toBe("{>>note<<} {>>reply<<}2. two\n3. three");
  });

  test("markup after a highlight containing a tracked change still counts as leading its line", () => {
    const doc = "{==a {++x++} b==}{++y++}{>>n\nm<<}\n2. two\n3. three";

    expect(deleteLine(doc, "2. two")).toBe("{==a {++x++} b==}{++y++}{>>n\nm<<}\n3. three");
  });

  test("a highlighted first item whose comment sits after a space and spans lines holds the list", () => {
    const doc = "{==1. one==} {>>note\nmore<<}\n2. two\n3. three";

    expect(deleteLine(doc, "2. two")).toBe("{==1. one==} {>>note\nmore<<}\n3. three");
  });

  test("a multi-line thread before an item's marker holds the list that ends above it", () => {
    const doc = "1. one\n2. two\n{>>note\nmore<<}{>>reply<<}3. three";

    expect(deleteLine(doc, "1. one")).toBe("2. two\n{>>note\nmore<<}{>>reply<<}3. three");
  });

  test("a comment at the start of a line with no marker after it does not hold the list", () => {
    const doc = "1. one\n2. two\n{>>note<<} prose\n3. three";

    expect(deleteLine(doc, "1. one")).toBe("1. two\n{>>note<<} prose\n2. three");
  });

  test("a highlighted first item whose comment spans lines holds the list", () => {
    const doc = "{==1. one==}{>>@A: why?\nmore\n<<}\n2. two\n3. three";

    expect(deleteLine(doc, "2. two")).toBe("{==1. one==}{>>@A: why?\nmore\n<<}\n3. three");
  });

  test("a long list renumbers to its end", () => {
    const items = Array.from({ length: 300 }, (_, index) => `${index + 1}. item ${index + 1}`);
    const doc = `${items.join("\n")}\n`;
    const next = deleteLine(doc, "1. item 1\n");

    expect(next.split("\n")[298]).toBe("299. item 300");
  });

  test("a list whose last item is wrapped in review markup is left alone", () => {
    const doc = "1. one\n2. two\n{==3. three==}{>>@A: why?<<}\n";

    expect(deleteLine(doc, "1. one")).toBe("2. two\n{==3. three==}{>>@A: why?<<}\n");
  });

  test("an inline HTML line straight after an item continues the list", () => {
    const doc = "1. one\n2. two\n<em>continuation</em>\n3. three\n4. four\n";

    expect(deleteLine(doc, "2. two")).toBe("1. one\n<em>continuation</em>\n2. three\n3. four\n");
  });

  test("numbered lines inside multi-line inline code or a table are not list items", () => {
    const code = "Example: `labels\n2. two\n4. four\n`.\n";
    const at = code.indexOf("two") + 3;
    const typed = editor(code).update({ changes: { from: at, insert: "s" }, userEvent: "input.type" });
    expect(typed.state.doc.toString()).toBe(code.replace("two", "twos"));

    const table = "| a | b |\n| - | - |\n2. two | x\n4. four | y\n";
    const at2 = table.indexOf("two") + 3;
    const edited = editor(table).update({ changes: { from: at2, insert: "s" }, userEvent: "input.type" });
    expect(edited.state.doc.toString()).toBe(table.replace("two", "twos"));
  });

  test("a line starting with a pipe but no table continues the list", () => {
    const doc = "1. one\n2. two\n| continuation\n3. three\n4. four\n";

    expect(deleteLine(doc, "2. two")).toBe("1. one\n| continuation\n2. three\n3. four\n");
  });

  test("remote snapshots, code blocks and prose are left alone", () => {
    const doc = "1. one\n2. two\n3. three\n";
    const remote: TransactionSpec = {
      changes: lineRange(doc, "2. two"),
      annotations: Transaction.remote.of(true),
    };
    expect(editor(doc).update(remote).state.doc.toString()).toBe("1. one\n3. three\n");

    const code = "```\n1. one\n2. two\n3. three\n```\n";
    expect(deleteLine(code, "2. two")).toBe("```\n1. one\n3. three\n```\n");

    const prose = "Intro.\n\n2. two\n\nMore prose.\n";
    expect(deleteLine(prose, "Intro.")).toBe("\n2. two\n\nMore prose.\n");
  });
});
