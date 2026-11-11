import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { acmFormattingKeymap, planToggle, planMultiToggle } from "./formatting";
import type { ToggleEdit, ToggleMarker } from "./formatting";

/** Apply a flat list of edits (original coords, non-overlapping) right-to-left. */
function applyEdits(doc: string, edits: ToggleEdit[]): string {
  let out = doc;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  }
  return out;
}

/** Apply a plan's edits to `doc` (edits are non-overlapping, in original
 *  coordinates) and return the resulting string + selection slice. */
function apply(doc: string, from: number, to: number, marker: ToggleMarker) {
  const plan = planToggle(doc, from, to, marker);
  // Apply right-to-left so earlier offsets stay valid.
  const edits = [...plan.edits].sort((a, b) => b.from - a.from);
  let out = doc;
  for (const e of edits as ToggleEdit[]) {
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  }
  return { out, anchor: plan.anchor, head: plan.head, selected: out.slice(plan.anchor, plan.head) };
}

describe("planToggle — wrap", () => {
  test("wraps a plain selection in italic", () => {
    const doc = "the word here";
    const r = apply(doc, 4, 8, "*"); // "word"
    expect(r.out).toBe("the *word* here");
    expect(r.selected).toBe("word");
  });

  test("wraps a plain selection in bold", () => {
    const doc = "the word here";
    const r = apply(doc, 4, 8, "**");
    expect(r.out).toBe("the **word** here");
    expect(r.selected).toBe("word");
  });

  test("keeps markers tight when the selection has leading/trailing spaces", () => {
    const doc = "a word b";
    const r = apply(doc, 1, 7, "*"); // " word " (with surrounding spaces)
    expect(r.out).toBe("a *word* b");
    expect(r.selected).toBe("word");
  });
});

describe("planToggle — unwrap", () => {
  test("unwraps when the markers are INSIDE the selection (italic)", () => {
    const doc = "the *word* here";
    const r = apply(doc, 4, 10, "*"); // "*word*"
    expect(r.out).toBe("the word here");
    expect(r.selected).toBe("word");
  });

  test("unwraps when the markers are JUST OUTSIDE the selection (italic)", () => {
    const doc = "the *word* here";
    const r = apply(doc, 5, 9, "*"); // "word", flanked by *
    expect(r.out).toBe("the word here");
    expect(r.selected).toBe("word");
  });

  test("unwraps bold from inside the selection", () => {
    const doc = "the **word** here";
    const r = apply(doc, 4, 12, "**"); // "**word**"
    expect(r.out).toBe("the word here");
    expect(r.selected).toBe("word");
  });

  test("unwraps bold from just outside the selection", () => {
    const doc = "the **word** here";
    const r = apply(doc, 6, 10, "**"); // "word"
    expect(r.out).toBe("the word here");
    expect(r.selected).toBe("word");
  });
});

describe("planToggle — italic / bold disambiguation", () => {
  test("⌘I on a **bold** selection adds an italic layer (does NOT peel a star)", () => {
    const doc = "the **word** here";
    const r = apply(doc, 4, 12, "*"); // "**word**" selected, toggling italic
    expect(r.out).toBe("the ***word*** here");
    expect(r.selected).toBe("**word**");
  });

  test("⌘I with bold markers just outside wraps rather than peeling", () => {
    const doc = "the **word** here";
    const r = apply(doc, 6, 10, "*"); // "word" inside a bold wrap, toggling italic
    expect(r.out).toBe("the ***word*** here");
    expect(r.selected).toBe("word");
  });
});

describe("planMultiToggle — multi-cursor (the changeByRange bug)", () => {
  test("wraps two separate cursors against the ORIGINAL doc, with correct selections", () => {
    const doc = "aa bb cc dd";
    // Two cursors: "bb" [3,5] and "dd" [9,11].
    const { edits, sel } = planMultiToggle(doc, [{ from: 3, to: 5 }, { from: 9, to: 11 }], "*");
    const out = applyEdits(doc, edits);
    expect(out).toBe("aa *bb* cc *dd*");
    // Both selections must still cover their own word after all edits applied.
    expect(out.slice(sel[0].anchor, sel[0].head)).toBe("bb");
    expect(out.slice(sel[1].anchor, sel[1].head)).toBe("dd");
  });

  test("single range matches planToggle (no regression)", () => {
    const { sel } = planMultiToggle("the word here", [{ from: 4, to: 8 }], "*");
    expect(sel).toEqual([{ anchor: 5, head: 9 }]);
  });
});

describe("planToggle — empty selection", () => {
  test("inserts an empty italic pair and parks the cursor between", () => {
    const doc = "ab";
    const r = apply(doc, 1, 1, "*");
    expect(r.out).toBe("a**b");
    expect(r.anchor).toBe(2);
    expect(r.head).toBe(2);
  });

  test("inserts an empty bold pair and parks the cursor between", () => {
    const doc = "ab";
    const r = apply(doc, 1, 1, "**");
    expect(r.out).toBe("a****b");
    expect(r.anchor).toBe(3);
    expect(r.head).toBe(3);
  });
});

describe("planToggle — underline (<u>…</u>, #38)", () => {
  const U = { open: "<u>", close: "</u>" };

  test("wraps a plain selection in <u> tags, keeping surrounding spaces outside", () => {
    const r = apply("a word b", 1, 7, U); // " word "
    expect(r.out).toBe("a <u>word</u> b");
    expect(r.selected).toBe("word");
  });

  test("unwraps when the tags are INSIDE the selection", () => {
    const r = apply("the <u>word</u> here", 4, 15, U); // "<u>word</u>"
    expect(r.out).toBe("the word here");
    expect(r.selected).toBe("word");
  });

  test("unwraps when the tags sit JUST OUTSIDE the selection", () => {
    const r = apply("the <u>word</u> here", 7, 11, U); // "word"
    expect(r.out).toBe("the word here");
    expect(r.selected).toBe("word");
  });

  test("an empty selection inserts an empty pair and parks the cursor between the tags", () => {
    const r = apply("ab", 1, 1, U);
    expect(r.out).toBe("a<u></u>b");
    expect(r.anchor).toBe(4);
    expect(r.head).toBe(4);
  });

  test("underlining bold text wraps outside the stars rather than touching them", () => {
    const r = apply("the **word** here", 4, 12, U);
    expect(r.out).toBe("the <u>**word**</u> here");
    expect(r.selected).toBe("**word**");
  });

  test("a selection between two separate spans wraps instead of unpairing them", () => {
    const doc = "<u>one</u> and <u>two</u>";
    const r = apply(doc, 3, 21, U); // "one</u> and <u>two", flanked by the outer tags
    expect(r.out).toBe("<u><u>one</u> and <u>two</u></u>");
  });

  test("selecting two whole spans wraps them rather than stripping the outer tags", () => {
    const doc = "<u>one</u> and <u>two</u>";
    const r = apply(doc, 0, doc.length, U);
    expect(r.out).toBe("<u><u>one</u> and <u>two</u></u>");
  });

  test("tag case does not hide two separate spans from the balance check", () => {
    const doc = "<u>one</U> and <U>two</u>";
    const r = apply(doc, 0, doc.length, U);
    expect(r.out).toBe("<u><u>one</U> and <U>two</u></u>");
  });

  test("multi-cursor wraps each range against the original doc", () => {
    const doc = "aa bb cc dd";
    const { edits, sel } = planMultiToggle(doc, [{ from: 3, to: 5 }, { from: 9, to: 11 }], U);
    const out = applyEdits(doc, edits);
    expect(out).toBe("aa <u>bb</u> cc <u>dd</u>");
    expect(sel.map((s) => out.slice(s.anchor, s.head))).toEqual(["bb", "dd"]);
  });
});

describe("acmFormattingKeymap", () => {
  /** Run the keymap's command for `key` on a doc with `[from,to)` selected; return the new doc. */
  function press(key: string, doc: string, from: number, to: number): string {
    const binding = acmFormattingKeymap.find((b) => b.key === key);
    if (!binding?.run) throw new Error(`no binding for ${key}`);
    let state = EditorState.create({ doc, selection: { anchor: from, head: to } });
    const view = {
      get state() {
        return state;
      },
      dispatch: (spec: Parameters<EditorState["update"]>[0]) => {
        state = state.update(spec).state;
      },
    };
    expect(binding.run(view as unknown as EditorView)).toBe(true);
    return state.doc.toString();
  }

  test("binds exactly bold, italic and underline, each preventing the browser default", () => {
    expect(acmFormattingKeymap.map((b) => [b.key, b.preventDefault])).toEqual([
      ["Mod-b", true],
      ["Mod-i", true],
      ["Mod-u", true],
    ]);
  });

  test("Mod-u underlines the selection (overriding CodeMirror's undoSelection)", () => {
    expect(press("Mod-u", "the word here", 4, 8)).toBe("the <u>word</u> here");
  });

  test("Mod-b still bolds the selection", () => {
    expect(press("Mod-b", "the word here", 4, 8)).toBe("the **word** here");
  });
});
