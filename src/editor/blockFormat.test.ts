import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { blockStyleChanges, currentBlockStyle, linkInsert, listChanges, setBlockStyle } from "./blockFormat";
import type { BlockStyle, ListKind } from "./blockFormat";
import { CriticMarkup } from "./criticMarkupParser";

// The parser the editor itself runs (useCodeMirror.ts).
const editorLanguage = markdown({ base: markdownLanguage, extensions: [CriticMarkup] });

function select(doc: string, from: string, to = from) {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(doc.indexOf(from), doc.indexOf(to) + to.length),
    extensions: [editorLanguage],
  });
}

const styled = (state: EditorState, style: BlockStyle) =>
  state.update({ changes: blockStyleChanges(state, style) }).state.doc.toString();
const listed = (state: EditorState, kind: ListKind) =>
  state.update({ changes: listChanges(state, kind) }).state.doc.toString();

describe("toolbar block formatting (#79)", () => {
  test("paragraph style sets, changes and clears a heading on the cursor's line", () => {
    expect(styled(select("Intro\nBody", "Intro"), 2)).toBe("## Intro\nBody");
    expect(styled(select("# Intro\nBody", "Intro"), 3)).toBe("### Intro\nBody");
    expect(styled(select("## Intro\nBody", "Intro"), 0)).toBe("Intro\nBody");
    expect(currentBlockStyle(select("## Intro", "Intro"))).toBe(2);
  });

  test("a selection ending at the next line's start, and blank lines, are left alone", () => {
    const doc = "Intro\nBody";
    const lineSelected = EditorState.create({ doc, selection: EditorSelection.single(0, 6), extensions: [editorLanguage] });
    expect(styled(lineSelected, 2)).toBe("## Intro\nBody");
    expect(listed(lineSelected, "bullet")).toBe("- Intro\nBody");

    expect(styled(select("One\n\nTwo", "One", "Two"), 1)).toBe("# One\n\n# Two");
  });

  test("the caret on an empty line starts a heading or a list there", () => {
    const empty = EditorState.create({ doc: "One\n\nTwo", selection: EditorSelection.cursor(4), extensions: [editorLanguage] });
    expect(styled(empty, 2)).toBe("One\n## \nTwo");
    expect(listed(empty, "bullet")).toBe("One\n- \nTwo");
  });

  test("a closing hash run goes with the heading; indentation stays before a new marker", () => {
    expect(styled(select("# Title #\nBody", "Title"), 0)).toBe("Title\nBody");
    expect(listed(select("- parent\n  child", "child"), "bullet")).toBe("- parent\n  - child");
  });

  test("lines inside a multi-line comment are never formatted", () => {
    const doc = "Before {>>@a: note\nmore<<} after";
    expect(styled(select(doc, "Before", "after"), 1)).toBe("# Before {>>@a: note\nmore<<} after");
    expect(listed(select(doc, "Before", "after"), "bullet")).toBe("- Before {>>@a: note\nmore<<} after");
  });

  test("a link label keeps literal brackets as text", () => {
    expect(linkInsert("x[y]z")).toEqual({ insert: "[x\\[y\\]z](url)", url: [10, 13] });
  });

  test("lists apply to every selected line and toggle off when all already are", () => {
    expect(listed(select("one\ntwo\n\nlater", "one", "two"), "number")).toBe("1. one\n2. two\n\nlater");
    expect(listed(select("- one\n- two", "one", "two"), "bullet")).toBe("one\ntwo");
    expect(listed(select("1. one\n2. two", "one", "two"), "bullet")).toBe("- one\n- two");
  });
});

describe("Setext headings in the paragraph-style menu (#6)", () => {
  /** What the toolbar's menu does: `setBlockStyle` on a view holding `state`. */
  function afterMenuPick(state: EditorState, style: BlockStyle) {
    const view = {
      state,
      dispatch(spec: TransactionSpec) {
        view.state = view.state.update(spec).state;
      },
      focus() {},
    };
    setBlockStyle(view as unknown as EditorView, style);
    return view.state.doc.toString();
  }

  test("an === underline reads as Heading 1 from the title line", () => {
    expect(currentBlockStyle(select("Title\n===\nBody", "Title"))).toBe(1);
  });

  test("a --- underline reads as Heading 2 from the title line", () => {
    expect(currentBlockStyle(select("Title\n---\nBody", "Title"))).toBe(2);
  });

  test("the caret on the underline itself reads the heading's level", () => {
    expect(currentBlockStyle(select("Title\n===\nBody", "==="))).toBe(1);
  });

  test("Normal text leaves the underline as a blank line above following text", () => {
    expect(afterMenuPick(select("Title\n===\nBody", "Title"), 0)).toBe("Title\n\nBody");
  });

  test("Normal text picked from the underline line clears the heading too", () => {
    expect(afterMenuPick(select("Title\n---\nBody", "---"), 0)).toBe("Title\n\nBody");
  });

  test("Normal text removes the underline line when a blank line already follows", () => {
    expect(afterMenuPick(select("Title\n===\n\nBody", "Title"), 0)).toBe("Title\n\nBody");
  });

  test("Normal text removes the underline line at the end of the document", () => {
    expect(afterMenuPick(select("Title\n===", "Title"), 0)).toBe("Title");
  });

  test("clearing above an indented code block keeps it a code block", () => {
    const cleared = afterMenuPick(select("Title\n===\n    code", "Title"), 0);

    expect(cleared).toBe("Title\n\n    code");
    expect(syntaxTree(select(cleared, "Title")).toString()).toBe("Document(Paragraph,CodeBlock(CodeText))");
  });

  test("clearing above an ordered list starting past 1 keeps it a list", () => {
    expect(afterMenuPick(select("Title\n===\n2. item", "Title"), 0)).toBe("Title\n\n2. item");
  });

  test("a selection over both lines changes the heading once", () => {
    expect(afterMenuPick(select("Title\n===\nBody", "Title", "==="), 2)).toBe("## Title\nBody");
  });

  test("switching level swaps the underline for the ATX marker", () => {
    expect(afterMenuPick(select("Title\n---\nBody", "Title"), 1)).toBe("# Title\nBody");
  });

  test("switching to Heading 3, which has no underline form, also goes to ATX", () => {
    expect(afterMenuPick(select("Title\n===\nBody", "Title"), 3)).toBe("### Title\nBody");
  });

  test("switching a multi-line title joins it, since ATX is one line", () => {
    expect(afterMenuPick(select("One\nTwo\n===\nBody", "One"), 2)).toBe("## One Two\nBody");
  });

  test("clearing a multi-line title keeps its line break", () => {
    expect(afterMenuPick(select("One\nTwo\n===\nBody", "Two"), 0)).toBe("One\nTwo\n\nBody");
  });

  test("a heading in a blockquote keeps the quote marker", () => {
    expect(afterMenuPick(select("> Title\n> ===\n\nBody", "Title"), 2)).toBe("> ## Title\n\nBody");
    expect(afterMenuPick(select("> Title\n> ===\n\nBody", "Title"), 0)).toBe("> Title\n\nBody");
  });

  test("joining a multi-line title in a blockquote drops the inner quote marker", () => {
    expect(afterMenuPick(select("> One\n> Two\n> ===", "One"), 1)).toBe("> # One Two");
  });

  test("joining keeps a literal > that the parser did not read as a quote marker", () => {
    expect(afterMenuPick(select("One\n    > Two\n===", "One"), 1)).toBe("# One > Two");
  });

  test("clearing a heading right above another Setext heading keeps them apart", () => {
    const cleared = afterMenuPick(select("First\n===\nSecond\n---", "First"), 0);

    expect(cleared).toBe("First\n\nSecond\n---");
    expect(syntaxTree(select(cleared, "First")).toString()).toBe("Document(Paragraph,SetextHeading2(HeaderMark))");
  });

  test("a trailing hash run in the title stays text once the heading is ATX", () => {
    const switched = afterMenuPick(select("Title #\n===", "Title"), 2);

    expect(switched).toBe("## Title \\#");
    expect(syntaxTree(select(switched, "Title")).toString()).toBe("Document(ATXHeading2(HeaderMark,Escape))");
  });

  test("a heading beyond the parsed part of a long document is still found", () => {
    const filler = "Filler paragraph.\n\n".repeat(1000);

    expect(afterMenuPick(select(`${filler}Title\n===\nBody`, "Title"), 2)).toBe(`${filler}## Title\nBody`);
  });

  test("clearing above a horizontal rule keeps the rule from becoming an underline", () => {
    const cleared = afterMenuPick(select("Title\n===\n---", "Title"), 0);

    expect(cleared).toBe("Title\n\n---");
    expect(syntaxTree(select(cleared, "Title")).toString()).toBe("Document(Paragraph,HorizontalRule)");
  });

  test("clearing above a standalone = run keeps it from becoming an underline", () => {
    expect(afterMenuPick(select("Title\n===\n=", "Title"), 0)).toBe("Title\n\n=");
  });

  test("clearing above a quoted rule keeps the quote's boundary", () => {
    expect(afterMenuPick(select("> Title\n> ===\n> ---", "Title"), 0)).toBe("> Title\n> \n> ---");
  });

  test("joining consumes a backslash hard break", () => {
    expect(afterMenuPick(select("One\\\nTwo\n===\nBody", "One"), 2)).toBe("## One Two\nBody");
  });

  test("joining keeps an escaped backslash, which is not a hard break", () => {
    expect(afterMenuPick(select("One\\\\\nTwo\n===", "One"), 1)).toBe("# One\\\\ Two");
  });

  test("a comment contained in the title leaves the heading readable and clearable", () => {
    const state = select("Title {>>note\nmore<<}\n===\nBody", "Title");

    expect(currentBlockStyle(state)).toBe(1);
    expect(afterMenuPick(state, 0)).toBe("Title {>>note\nmore<<}\n\nBody");
  });

  test("switching level leaves a heading alone when a comment spans its title lines", () => {
    const doc = "Title {>>note\nmore<<}\n===";

    expect(afterMenuPick(select(doc, "Title"), 2)).toBe(doc);
  });

  test("a title that starts inside a comment opened earlier is the comment's text", () => {
    const doc = "# Head {>>a\nTitle<<}\n===";
    const state = select(doc, "Title");

    expect(currentBlockStyle(state)).toBe(0);
    expect(afterMenuPick(state, 0)).toBe(doc);
  });

  test("the style read finds a heading beyond the parsed part of a long document", () => {
    const filler = "Filler paragraph.\n\n".repeat(1000);

    expect(currentBlockStyle(select(`${filler}Title\n===\nBody`, "Title"))).toBe(1);
  });

  test("no available syntax tree means no change", () => {
    const state = EditorState.create({ doc: "Title\n===\nBody", selection: EditorSelection.cursor(0) });

    expect(blockStyleChanges(state, 2)).toEqual([]);
  });

  test("a line of === after a blank line is plain text and stays", () => {
    const state = select("Body\n\n===\n\nMore", "===");

    expect(currentBlockStyle(state)).toBe(0);
    expect(afterMenuPick(state, 0)).toBe("Body\n\n===\n\nMore");
  });

  test("a line of === in a code block stays", () => {
    const state = select("```\nTitle\n===\n```", "Title");

    expect(currentBlockStyle(state)).toBe(0);
    expect(afterMenuPick(state, 0)).toBe("```\nTitle\n===\n```");
  });

  test("an underline inside a multi-line comment is the comment's text, not a heading", () => {
    const doc = "Title {>>note\n===\n<<}";
    const state = select(doc, "Title");

    expect(currentBlockStyle(state)).toBe(0);
    expect(afterMenuPick(state, 0)).toBe(doc);
  });

  test("an ATX heading on the parsed document still works", () => {
    const state = select("# Title #\nBody", "Title");

    expect(currentBlockStyle(state)).toBe(1);
    expect(afterMenuPick(state, 0)).toBe("Title\nBody");
  });
});
