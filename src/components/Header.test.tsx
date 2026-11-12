import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS } from "../lib/viewSettings";
import { version } from "../../package.json";
import Header from "./Header";

const noop = () => {};

function renderHeader(): string {
  return renderToStaticMarkup(
    <Header
      connected
      saveState="saved"
      lastSavedAt={null}
      wordCount={1280}
      onWrap={noop}
      tocOpen={false}
      onToggleToc={noop}
      commentRailVisible={false}
      commentsSurface="rail"
      onToggleCommentRail={noop}
      settings={DEFAULT_SETTINGS}
      onChangeSettings={noop}
      settingsSaveError={false}
      onRetrySettings={noop}
      settingsOpen={false}
      onSetSettingsOpen={noop}
      onShowShortcuts={noop}
      onPrint={noop}
      dictionary={[]}
      onAddWord={noop}
      onRemoveWord={noop}
      flaggedCount={0}
      onOpenReview={noop}
    />,
  );
}

describe("header information architecture", () => {
  test("keeps document controls left and review controls right", () => {
    const html = renderHeader();
    const toc = html.indexOf('aria-label="Table of contents"');
    const source = html.indexOf('aria-label="Show raw Markdown source"');
    const brand = html.indexOf("ACM");
    const comments = html.indexOf('aria-label="Show comments edge"');
    const settings = html.indexOf('aria-label="Settings"');

    expect(toc).toBeGreaterThanOrEqual(0);
    expect(source).toBeGreaterThan(toc);
    expect(brand).toBeGreaterThan(source);
    expect(comments).toBeGreaterThan(brand);
    expect(settings).toBeGreaterThan(comments);
    expect(html).not.toContain("overview");
  });

  test("shows the installed version on an info button after the source toggle (#55)", () => {
    const html = renderHeader();
    const source = html.indexOf('aria-label="Show raw Markdown source"');
    const info = html.indexOf(`aria-label="About ACM: version ${version}"`);

    expect(info).toBeGreaterThan(source);
    expect(html).toContain(`title="ACM ${version}"`);
    expect(html).toContain("lucide-info");
  });

  test("uses the shared icon set for every header action", () => {
    const html = renderHeader();

    expect(html).toContain("lucide-list-tree");
    expect(html).toContain("lucide-code-xml");
    expect(html).toContain("lucide-panel-right");
    expect(html).toContain("lucide-settings");
  });
});
