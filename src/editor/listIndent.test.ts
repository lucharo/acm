import { describe, expect, test } from "bun:test";
import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { planListIndent, listIndentKeymap } from "./listIndent";

function state(doc: string, anchor: number, head = anchor, withHistory = false) {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdown({ base: markdownLanguage }), ...(withHistory ? [history()] : [])],
  });
}

function applyPlan(current: EditorState, direction: "indent" | "outdent") {
  const plan = planListIndent(current, direction);
  return { plan, state: current.update({ changes: plan.changes }).state };
}

describe("list indentation", () => {
  test("Tab indents the complete current list item without stray partial whitespace", () => {
    const doc = "- parent\n- second\n  continuation";
    const current = state(doc, doc.indexOf("second"));

    const { plan, state: next } = applyPlan(current, "indent");

    expect(plan.handled).toBe(true);
    expect(next.doc.toString()).toBe("- parent\n    - second\n      continuation");
    expect(syntaxTree(next).toString()).toContain(
      "ListItem(ListMark,Paragraph,BulletList(ListItem",
    );
  });

  test("Tab at the end of a list item still indents that item", () => {
    const doc = "- parent\n- child";
    const current = state(doc, doc.length);

    const { plan, state: next } = applyPlan(current, "indent");

    expect(plan.handled).toBe(true);
    expect(next.doc.toString()).toBe("- parent\n    - child");
  });

  test("Tab uses a three-digit ordered marker's content column for nesting", () => {
    const doc = "100. parent\n101. child";
    const current = state(doc, doc.indexOf("child"));

    const { plan, state: next } = applyPlan(current, "indent");

    expect(plan.handled).toBe(true);
    expect(next.doc.toString()).toBe("100. parent\n     101. child");
    expect(syntaxTree(next).toString()).toContain(
      "ListItem(ListMark,Paragraph,OrderedList(ListItem",
    );
  });

  test("Tab leaves loose-list blank lines empty", () => {
    const doc = "- parent\n- child\n\n  continuation";
    const current = state(doc, doc.indexOf("child"));

    const { plan, state: next } = applyPlan(current, "indent");

    expect(plan.handled).toBe(true);
    expect(next.doc.toString()).toBe("- parent\n    - child\n\n      continuation");
  });

  test("Tab on the first sibling does not turn a list item into an indented code block", () => {
    const doc = "- first\n- second";
    const current = state(doc, doc.indexOf("first"));

    const { plan, state: next } = applyPlan(current, "indent");

    expect(plan).toEqual({ handled: true, changes: [] });
    expect(next.doc.toString()).toBe(doc);
  });

  test("Shift-Tab outdents a nested item and its continuation as one block", () => {
    const doc = "- parent\n  - child\n    detail";
    const current = state(doc, doc.indexOf("child"));

    const { plan, state: next } = applyPlan(current, "outdent");

    expect(plan.handled).toBe(true);
    expect(next.doc.toString()).toBe("- parent\n- child\n  detail");
  });

  test("Shift-Tab removes the complete ordered-list nesting column", () => {
    const doc = "100. parent\n     101. child\n          detail";
    const current = state(doc, doc.indexOf("child"));

    const { plan, state: next } = applyPlan(current, "outdent");

    expect(plan.handled).toBe(true);
    expect(next.doc.toString()).toBe("100. parent\n101. child\n     detail");
  });

  test("ordered markers keep a byte-identical indent and outdent round trip", () => {
    for (const marker of ["1.", "9.", "10.", "100.", "1)"]) {
      const nextNumber = marker.endsWith(")") ? "2)" : "2.";
      const doc = `${marker} parent\n${nextNumber} child`;
      const indented = applyPlan(state(doc, doc.indexOf("child")), "indent").state;
      const outdented = applyPlan(
        state(indented.doc.toString(), indented.doc.toString().indexOf("child")),
        "outdent",
      ).state;

      expect(outdented.doc.toString()).toBe(doc);
    }
  });

  test("a keyboard selection spanning sibling items indents both exactly once", () => {
    const doc = "- parent\n- one\n- two\n- three";
    const current = state(doc, doc.indexOf("one") - 2, doc.indexOf("three") - 2);

    const { state: next } = applyPlan(current, "indent");

    expect(next.doc.toString()).toBe("- parent\n    - one\n    - two\n- three");
  });

  test("outside lists Tab is not handled, preserving normal focus navigation", () => {
    const current = state("ordinary prose", 4);

    expect(planListIndent(current, "indent")).toEqual({ handled: false, changes: [] });
  });

  test("one undo restores an indented list transaction", () => {
    let current = state("- parent\n- child", 11, 11, true);
    const target = {
      get state() {
        return current;
      },
      dispatch(spec: Parameters<EditorState["update"]>[0]) {
        current = current.update(spec).state;
      },
    } as unknown as EditorView;

    expect(listIndentKeymap[0].run?.(target)).toBe(true);
    expect(current.doc.toString()).toBe("- parent\n    - child");
    expect(undo(target)).toBe(true);
    expect(current.doc.toString()).toBe("- parent\n- child");
  });
});
