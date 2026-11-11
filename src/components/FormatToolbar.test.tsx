import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MOD } from "../lib/platform";
import FormatToolbar from "./FormatToolbar";

const noop = () => {};

describe("FormatToolbar", () => {
  test("offers Bold, Italic, Underline in that order, each naming its shortcut (#38)", () => {
    const html = renderToStaticMarkup(
      <FormatToolbar view={null} selectionTick={0} hasSelection={false} onAddComment={noop} onMakeSuggestion={noop} />,
    );

    const labels = [...html.matchAll(/title="([^"]+)" aria-label="(Bold|Italic|Underline|Insert link)"/g)].map(
      (m) => [m[2], m[1]],
    );
    expect(labels).toEqual([
      ["Bold", `Bold (${MOD}B)`],
      ["Italic", `Italic (${MOD}I)`],
      ["Underline", `Underline (${MOD}U)`],
      ["Insert link", "Insert link"],
    ]);
  });
});
