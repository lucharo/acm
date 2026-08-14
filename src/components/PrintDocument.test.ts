import { describe, expect, test } from "bun:test";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

import { preparePrintDocument } from "../lib/printDocument";
import {
  positionTufteReferenceRibs,
  renderPrintDocument,
  waitForPrintImages,
} from "./PrintDocument";

function rootElement() {
  const document = new DOMParser().parseFromString("<print/>", "application/xml");
  const root = document.documentElement;
  if (!root) throw new Error("test document has no root element");
  return root as unknown as HTMLElement;
}

describe("print document DOM", () => {
  test("simple output replaces footnote syntax with superscripts and renders endnotes", () => {
    const root = rootElement();
    const model = preparePrintDocument(
      "# Title\n\nA claim[^one].\n\n[^one]: Supporting **detail**.",
      "simple",
      true,
    );

    renderPrintDocument(root, { ok: true, model });
    const rendered = new XMLSerializer().serializeToString(root as never);

    expect(rendered).toContain('A claim<sup class="acm-print-footnote-ref">1</sup>.');
    expect(rendered).toContain('<section class="acm-print-endnotes"><h2>Notes</h2>');
    expect(rendered).toContain("Supporting <strong>detail</strong>.");
    expect(rendered).not.toContain("[^one]");
  });

  test("print output eagerly loads Markdown and safe HTML images", () => {
    const root = rootElement();
    const model = preparePrintDocument(
      "![Plot](plot.png)\n\n<img src=\"https://example.com/diagram.png\" alt=\"Diagram\">",
      "simple",
      true,
    );

    renderPrintDocument(root, { ok: true, model });
    const rendered = new XMLSerializer().serializeToString(root as never);

    expect(rendered).toContain('loading="eager"');
    expect(rendered).not.toContain('loading="lazy"');
  });

  test("print output renders inline and display LaTeX", () => {
    const root = rootElement();
    const model = preparePrintDocument(
      "Inline $E=mc^2$.\n\n$$\\sum_{i=1}^n i$$",
      "simple",
      true,
    );

    renderPrintDocument(root, { ok: true, model });
    const rendered = new XMLSerializer().serializeToString(root as never);

    expect(rendered).toContain('class="katex"');
    expect(rendered).toContain('class="katex-display"');
    expect(rendered).not.toContain("$E=mc^2$");
  });

  test("image preparation waits for both load and error without hanging", async () => {
    class FakeImage extends EventTarget {
      complete = false;
      currentSrc = "";
      constructor(readonly src: string) {
        super();
      }
      setAttribute() {}
    }
    const loaded = new FakeImage("loaded.png");
    const failed = new FakeImage("failed.png");
    const root = {
      getElementsByTagName: () => [loaded, failed],
    } as unknown as HTMLElement;

    const waiting = waitForPrintImages(root, 100);
    loaded.dispatchEvent(new Event("load"));
    failed.dispatchEvent(new Event("error"));

    expect(await waiting).toEqual([]);
  });

  test("image preparation reports sources still pending at its deadline", async () => {
    const image = {
      complete: false,
      currentSrc: "",
      src: "slow.png",
      addEventListener: () => {},
      removeEventListener: () => {},
      setAttribute: () => {},
    };
    const root = {
      getElementsByTagName: () => [image],
    } as unknown as HTMLElement;

    expect(await waitForPrintImages(root, 1)).toEqual(["slow.png"]);
  });

  test("image preparation resolves immediately when every image is complete", async () => {
    const root = {
      getElementsByTagName: () => [{ complete: true, setAttribute: () => {} }],
    } as unknown as HTMLElement;

    expect(await waitForPrintImages(root, 1)).toEqual([]);
  });

  test("image preparation makes every print image eager before checking completion", async () => {
    const attributes = new Map<string, string>();
    const image = {
      complete: true,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    };
    const root = {
      getElementsByTagName: () => [image],
    } as unknown as HTMLElement;

    expect(await waitForPrintImages(root, 1)).toEqual([]);
    expect(Object.fromEntries(attributes)).toEqual({
      fetchpriority: "high",
      loading: "eager",
    });
  });


  test("image preparation catches an image completing while listeners attach", async () => {
    let complete = false;
    const image = {
      get complete() {
        return complete;
      },
      currentSrc: "race.png",
      src: "race.png",
      addEventListener: () => {
        complete = true;
      },
      removeEventListener: () => {},
      setAttribute: () => {},
    };
    const root = {
      getElementsByTagName: () => [image],
    } as unknown as HTMLElement;

    expect(await waitForPrintImages(root, 1)).toEqual([]);
  });

  test("Tufte output groups same-page references in one initial outer rib", () => {
    const root = rootElement();
    const model = preparePrintDocument(
      "Claim[^one].\n\n> Short quote.\n\n[^one]: Note.",
      "tufte",
      true,
    );

    renderPrintDocument(root, { ok: true, model });
    const rendered = new XMLSerializer().serializeToString(root as never);

    expect(rendered).toContain('class="acm-print-rib acm-print-rib--right"');
    expect(rendered).not.toContain('class="acm-print-rib acm-print-rib--left"');
    expect(rendered.indexOf("acm-print-rib--right")).toBeLessThan(
      rendered.indexOf('class="acm-print-main"'),
    );
    expect(rendered).toContain("Short quote.");
    expect(rendered).not.toContain("&gt; Short quote.");
  });

  test("Tufte page parity is measured at the printable page width", () => {
    const classes = new Set(["acm-print-rib--right"]);
    const root = {
      style: { width: "" },
      getBoundingClientRect: () => ({ top: 0 }),
      querySelectorAll: () => [
        {
          getBoundingClientRect: () => ({
            top: root.style.width === "182mm" ? 210 : 110,
          }),
          querySelector: () => ({
            classList: {
              toggle(name: string, enabled: boolean) {
                if (enabled) classes.add(name);
                else classes.delete(name);
              },
            },
          }),
        },
      ],
    } as unknown as HTMLElement;

    positionTufteReferenceRibs(root, true, 100);

    expect(root.style.width).toBe("182mm");
    expect(classes.has("acm-print-rib--right")).toBe(true);
    expect(classes.has("acm-print-rib--left")).toBe(false);
  });

  test("switching from Tufte to Simple clears the measured page width", () => {
    const root = rootElement();
    root.setAttribute("style", "width: 182mm;");
    const model = preparePrintDocument("Simple body.", "simple", true);

    renderPrintDocument(root, { ok: true, model });

    expect(root.getAttribute("style")).toBeNull();
  });

  test("escaped and inline-code footnote shapes remain literal", () => {
    const root = rootElement();
    const model = preparePrintDocument(
      "Literal `[^one]`, escaped \\[^one], real[^one].\n\n[^one]: Note.",
      "simple",
      true,
    );

    renderPrintDocument(root, { ok: true, model });
    const rendered = new XMLSerializer().serializeToString(root as never);

    expect(rendered).toContain("<code>[^one]</code>");
    expect(rendered).toContain("escaped [^one]");
    expect(rendered).toContain('real<sup class="acm-print-footnote-ref">1</sup>');
  });

  test("footnote references honour odd and even backslash escape parity", () => {
    const root = rootElement();
    const model = preparePrintDocument(
      "Odd \\[^one], even \\\\[^one].\n\n[^one]: Note.",
      "simple",
      true,
    );

    renderPrintDocument(root, { ok: true, model });
    const rendered = new XMLSerializer().serializeToString(root as never);

    expect(rendered).toContain("Odd [^one], even \\");
    expect(rendered).toContain('<sup class="acm-print-footnote-ref">1</sup>.');
    expect(rendered).not.toContain("even \\[^one]");
  });

  test("footnote escape parity preserves every complete backslash pair", () => {
    const root = rootElement();
    const odd = "\\".repeat(5);
    const even = "\\".repeat(6);
    const model = preparePrintDocument(
      `Odd ${odd}[^one], even ${even}[^one].\n\n[^one]: Note.`,
      "simple",
      true,
    );

    renderPrintDocument(root, { ok: true, model });
    const rendered = new XMLSerializer().serializeToString(root as never);

    expect(rendered).toContain(`Odd ${"\\".repeat(2)}[^one]`);
    expect(rendered).toContain(
      `even ${"\\".repeat(3)}<sup class="acm-print-footnote-ref">1</sup>`,
    );
  });

  test("malformed review markup renders a blocking notice without source content", () => {
    const root = rootElement();

    renderPrintDocument(root, {
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
    const rendered = new XMLSerializer().serializeToString(root as never);

    expect(rendered).toContain("Printing paused");
    expect(rendered).toContain("Fix 1 markup issue before exporting this document.");
    expect(rendered).not.toContain("{++ never closes");
  });
});
