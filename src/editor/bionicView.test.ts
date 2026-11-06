import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import { CriticMarkup } from "./criticMarkupParser";
import { bionicRanges } from "./bionicView";

function boldedText(doc: string): string[] {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [CriticMarkup] })],
  });
  return bionicRanges(state, 0, doc.length).map(({ from, to }) => doc.slice(from, to));
}

describe("bionic reading", () => {
  test("bolds the lead of each prose word", () => {
    expect(boldedText("Read every card and decide.")).toEqual(["Re", "ev", "ca", "a", "dec"]);
  });

  test("leaves inline code, fenced code and URLs untouched (#69)", () => {
    const doc = [
      "Run `genimg pick` on https://example.com/genimg today.",
      "",
      "```bash",
      "echo hello",
      "```",
      "",
      "Done.",
    ].join("\n");

    expect(boldedText(doc)).toEqual(["R", "o", "to", "Do"]);
  });

  test("leaves inline HTML tags untouched", () => {
    expect(boldedText("Press <kbd>Enter</kbd> now.")).toEqual(["Pr", "En", "n"]);
  });

  test("leaves CriticMarkup spans and comment bodies untouched (#69)", () => {
    const doc =
      "Keep {++this insertion++} and {--that--} and {==mark==}{>>@claude: a note<<} plain.";

    expect(boldedText(doc)).toEqual(["Ke", "a", "a", "pl"]);
  });
});
