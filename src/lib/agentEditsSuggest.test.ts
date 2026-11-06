import { describe, expect, test } from "bun:test";

import { addComment, appendToThread, suggestionWhitespaceWarning } from "./agentEdits";
import { applicableSuggestionIds, validateMarkup } from "./criticmarkup";

const DOC =
  "{==Elliot, I want to help you.==}{>>@claude: hello<<}{>>@You: suggest edit<<} The rock.\n\n" +
  "{==need here to finish the story==}{>>@claude: hm<<}{>>@You: second thread<<}\n";

describe("empty-body SUGGEST through `acm reply` (#47)", () => {
  test("a reply whose text is a whole comment marker lands as that comment, not as escaped text", () => {
    const out = addComment(DOC, "second thread", "claude", "{>>@claude: SUGGEST: <<}");

    expect(out).toBe(
      DOC.replace("{>>@You: second thread<<}", "{>>@You: second thread<<}{>>@claude: ~acm1~SUGGEST: <<}"),
    );
    expect(validateMarkup(out)).toEqual([]);
    expect(applicableSuggestionIds(out).size).toBe(1);
  });

  test("a grouped empty SUGGEST replied as plain text is a valid deletion card", () => {
    const out = addComment(DOC, "second thread", "claude", "SUGGEST[g:cleanup]: ");

    expect(validateMarkup(out)).toEqual([]);
    expect(applicableSuggestionIds(out).size).toBe(1);
  });

  test("the same empty SUGGEST on a second thread is not skipped as a duplicate", () => {
    const marker = "{>>@claude: ~acm1~SUGGEST: <<}";
    const first = appendToThread(DOC, "suggest edit", marker);
    const second = appendToThread(first.content, "second thread", marker);

    expect([first.skipped, second.skipped]).toEqual([false, false]);
    expect(applicableSuggestionIds(second.content).size).toBe(2);
  });

  test("re-running the same reply on the same thread is still idempotent", () => {
    const marker = "{>>@claude: ~acm1~SUGGEST: <<}";
    const first = appendToThread(DOC, "second thread", marker);

    expect(appendToThread(first.content, "second thread", marker)).toEqual({
      content: first.content,
      skipped: true,
    });
  });
});

describe("acm suggest warns about boundary whitespace (#75)", () => {
  test("a span or replacement that starts or ends with whitespace gets one warning naming both", () => {
    expect(suggestionWhitespaceWarning(" adopted by 400+", " 400+ data")).toBe(
      "the span starts with whitespace and the replacement starts with whitespace — Apply replaces the span's whitespace with the replacement's, exactly as written; check the words on either side still read right",
    );
    expect(suggestionWhitespaceWarning("tail ", "end")).toBe(
      "the span ends with whitespace — Apply replaces the span's whitespace with the replacement's, exactly as written; check the words on either side still read right",
    );
  });

  test("clean span and replacement: no warning", () => {
    expect(suggestionWhitespaceWarning("adopted by", "used by")).toBeNull();
    expect(suggestionWhitespaceWarning("x", "")).toBeNull(); // a deletion
  });
});
