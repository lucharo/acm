import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import Launcher from "./Launcher";

function renderLauncher() {
  return renderToStaticMarkup(
    createElement(Launcher, {
      session: {
        mode: "launcher" as const,
        cwd: "/a/very/long/mobile/path/that/must/wrap/instead/of/overflowing",
        recent: [],
      },
    }),
  );
}

describe("mobile document launcher", () => {
  test("uses 16px path inputs so iOS does not zoom on focus", () => {
    const html = renderLauncher();

    expect(html).toMatch(/placeholder="notes\.md"[^>]*class="[^"]*text-base/);
    expect(html).toMatch(/placeholder="drafts\/essay\.md"[^>]*class="[^"]*text-base/);
  });

  test("keeps its primary buttons touch-sized", () => {
    const html = renderLauncher();

    expect(html.match(/min-h-11/g)?.length).toBe(2);
    expect(html).toContain("disabled:bg-transparent");
  });

  test("wraps the launch folder instead of widening the page", () => {
    expect(renderLauncher()).toContain("break-all");
  });
});
