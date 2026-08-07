import { expect, test } from "bun:test";
import { parser as markdownParser } from "@lezer/markdown";
import { CriticMarkup } from "./criticMarkupParser";
import { formatComment } from "../lib/criticmarkup";

test("a serialized blank-line comment remains one CriticMarkup node in the editor", () => {
  const source = `Before ${formatComment("Luis", "first line\n\nsecond line")} after`;
  const names: string[] = [];

  markdownParser.configure([CriticMarkup]).parse(source).iterate({
    enter(node) {
      names.push(node.name);
    },
  });

  expect(names.filter((name) => name === "CMComment")).toEqual(["CMComment"]);
});
