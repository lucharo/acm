import { describe, expect, test } from "bun:test";

import { acceptedMarkdown } from "./criticmarkup";

describe("accepted-state Markdown for print", () => {
  test("accepts native tracked changes, keeps highlights, and removes comments", () => {
    const source = [
      "# Draft",
      "",
      "Keep {++the addition++}, remove {--the deletion--}, and use {~~old~>new~~} wording.",
      "",
      "{==Highlighted **prose**==}{>>@Reviewer: discuss this<<}",
    ].join("\n");

    expect(acceptedMarkdown(source)).toEqual({
      ok: true,
      markdown: [
        "# Draft",
        "",
        "Keep the addition, remove , and use new wording.",
        "",
        "Highlighted **prose**",
      ].join("\n"),
    });
  });

  test("keeps the original wording for pending anchored SUGGEST comments", () => {
    const source = "{==Original wording==}{>>@Agent: SUGGEST: Replacement wording<<}";

    expect(acceptedMarkdown(source)).toEqual({
      ok: true,
      markdown: "Original wording",
    });
  });

  test("accepts multiline standalone additions with rich Markdown intact", () => {
    const source = "{++## Added\n\n- **one**\n- [second](https://example.com)\n- `code`++}";

    expect(acceptedMarkdown(source)).toEqual({
      ok: true,
      markdown: "## Added\n\n- **one**\n- [second](https://example.com)\n- `code`",
    });
  });

  test("refuses malformed markup instead of leaking delimiters into print", () => {
    const result = acceptedMarkdown("Before {++unfinished\n\nAfter");

    expect(result).toEqual({
      ok: false,
      diagnostics: [
        {
          from: 7,
          to: 10,
          kind: "dangling-open",
          message: "{++ never closes in this paragraph",
        },
      ],
    });
  });

  test("preserves CriticMarkup-shaped text inside fenced and indented code", () => {
    const source = [
      "```md",
      "{++literal fenced addition++}",
      "```",
      "",
      "    {--literal indented deletion--}",
    ].join("\n");

    expect(acceptedMarkdown(source)).toEqual({ ok: true, markdown: source });
  });

  test("preserves CriticMarkup-shaped text inside inline code", () => {
    const source = "Use `{--literal deletion--}` and `{++literal addition++}` in examples.";

    expect(acceptedMarkdown(source)).toEqual({ ok: true, markdown: source });
  });

  test("does not treat a dangling delimiter inside code as malformed review markup", () => {
    const source = "```text\n{++literal unfinished marker\n```";

    expect(acceptedMarkdown(source)).toEqual({ ok: true, markdown: source });
  });

  test("preserves CriticMarkup-shaped text inside raw code elements", () => {
    const source = "A literal <code>{++example++}</code> remains code.";

    expect(acceptedMarkdown(source)).toEqual({ ok: true, markdown: source });
  });
});
