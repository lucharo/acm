import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDocText, writeDocText } from "./docText";

const BOM = "\uFEFF";
const tmp = (seed: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "acm-doctext-")), "doc.md");
  writeFileSync(path, seed);
  return path;
};

describe("docText (#92)", () => {
  test("reads without the BOM and writes it back when the file had one", async () => {
    const path = tmp(`${BOM}# A\n`);
    expect(await readDocText(path)).toBe("# A\n");
    await writeDocText(path, "# B\n");
    expect(readFileSync(path, "utf8")).toBe(`${BOM}# B\n`);
  });

  test("never adds a BOM to a file that had none", async () => {
    const path = tmp("# A\n");
    await writeDocText(path, "# B\n");
    expect(readFileSync(path, "utf8")).toBe("# B\n");
  });

  test("refuses text that itself starts with U+FEFF rather than silently dropping it", async () => {
    const path = tmp("{--Gone--}\uFEFFKeep.\n");
    await expect(writeDocText(path, `${BOM}Keep.\n`)).rejects.toThrow("U+FEFF");
    expect(readFileSync(path, "utf8")).toBe("{--Gone--}\uFEFFKeep.\n");
  });

  test("a missing document throws instead of reading as empty", async () => {
    await expect(readDocText(join(tmpdir(), "acm-doctext-missing-xyz.md"))).rejects.toThrow();
  });
});
