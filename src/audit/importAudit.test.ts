// ── Import audit (#21): Google Docs / .docx → CriticMarkup ────────────────────
// Each test pins a defect the audit reproduced with a real .docx archive and
// drives the real conversion path. Temp dirs only.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { convertDocx } from "../cli/docxImport";
import { validateMarkup } from "../lib/criticmarkup";

const CLI = resolve(import.meta.dir, "../../cli.ts");
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "acm-import-audit-"));
  temporaryDirectories.push(dir);
  return dir;
}

function docx(documentBody: string, comments = ""): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="${WORD_NS}" xmlns:mc="${MC_NS}"><w:body>${documentBody}</w:body></w:document>`,
    ),
  };
  if (comments) {
    files["word/comments.xml"] = strToU8(
      `<?xml version="1.0"?><w:comments xmlns:w="${WORD_NS}">${comments}</w:comments>`,
    );
  }
  return zipSync(files);
}
const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (content: string) => `<w:p>${content}</w:p>`;
const comment = (id: string, author: string, body: string) =>
  `<w:comment w:id="${id}" w:author="${author}">${paragraph(run(body))}</w:comment>`;
const rangeStart = (id: string) => `<w:commentRangeStart w:id="${id}"/>`;
const rangeEnd = (id: string) => `<w:commentRangeEnd w:id="${id}"/>`;

describe("audit: tracked changes import as balanced suggestions", () => {
  test("paragraph-mark and table-row revision markers add no empty suggestions", () => {
    const archive = docx(
      `<w:p><w:pPr><w:rPr><w:ins w:id="1" w:author="A"/></w:rPr></w:pPr><w:ins w:id="2" w:author="A">${run("new para")}</w:ins></w:p>
       <w:p><w:pPr><w:rPr><w:del w:id="3" w:author="A"/></w:rPr></w:pPr></w:p>
       <w:tbl><w:tr><w:trPr><w:ins w:id="4" w:author="A"/></w:trPr><w:tc>${paragraph(run("cell"))}</w:tc></w:tr></w:tbl>`,
    );

    const result = convertDocx(archive);

    expect(result.markdown).toBe("{++new para++}\n\ncell\n");
  });

  test("a tracked move imports as a deletion and an insertion, not as the prose twice", () => {
    const archive = docx(
      paragraph(`<w:moveFrom w:id="1">${run("moved")}</w:moveFrom>${run(" stay ")}<w:moveTo w:id="2">${run("moved")}</w:moveTo>`),
    );

    const result = convertDocx(archive);

    expect(result.markdown).toBe("{--moved--} stay {++moved++}\n");
  });

  test("a deletion nested in an insertion splits into adjacent suggestions", () => {
    const archive = docx(
      paragraph(`<w:ins w:id="1">${run("kept ")}<w:del w:id="2"><w:r><w:delText>gone</w:delText></w:r></w:del></w:ins>`),
    );

    const result = convertDocx(archive);

    expect(result.markdown).toBe("{++kept ++}{--gone--}\n");
    expect(validateMarkup(result.markdown)).toEqual([]);
  });

  test("a paragraph break inside a tracked insertion closes and reopens the suggestion", () => {
    const archive = docx(
      paragraph(
        `<w:ins w:id="1"><w:r><w:t>caption </w:t><w:drawing><w:txbxContent>${paragraph(run("boxed"))}${paragraph(run("second"))}</w:txbxContent></w:drawing></w:r></w:ins>${run("tail")}`,
      ),
    );

    const result = convertDocx(archive);

    expect(result.markdown).toBe("{++caption boxed++}\n\n{++second++}\n\ntail\n");
    expect(validateMarkup(result.markdown)).toEqual([]);
  });
});

describe("audit: prose survives exactly once", () => {
  test("a text box with a compatibility fallback imports once", () => {
    const box = `<w:txbxContent>${paragraph(run("boxed"))}</w:txbxContent>`;
    const archive = docx(
      paragraph(
        `${run("before ")}<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>${box}</w:drawing></mc:Choice><mc:Fallback><w:pict>${box}</w:pict></mc:Fallback></mc:AlternateContent>`,
      ),
    );

    const result = convertDocx(archive);

    expect(result.markdown).toBe("before boxed\n");
  });

  test("a non-breaking hyphen stays in the word", () => {
    const archive = docx(paragraph(`<w:r><w:t>well</w:t><w:noBreakHyphen/><w:t>known</w:t></w:r>`));

    const result = convertDocx(archive);

    expect(result.markdown).toBe("well‑known\n");
  });
});

describe("audit: comment anchors stay valid markup", () => {
  test("an anchor holding a blank line degrades to a point comment", () => {
    const archive = docx(
      paragraph(`${rangeStart("1")}<w:r><w:t>first</w:t><w:br/><w:br/><w:t>second</w:t></w:r>${rangeEnd("1")}`),
      comment("1", "Editor", "Note."),
    );

    const result = convertDocx(archive);

    expect(result).toEqual({
      markdown: "first\n\nsecond{>>@Editor: Note.<<}\n",
      comments: 1,
      highlights: 0,
    });
    expect(validateMarkup(result.markdown)).toEqual([]);
  });

  test.each([
    { name: "highlight", xml: "a ==} b", prose: "a ==} b" },
    { name: "comment", xml: "a &lt;&lt;} b", prose: "a <<} b" },
  ])("an anchor holding a literal $name close marker is not wrapped", ({ xml, prose }) => {
    const archive = docx(paragraph(`${rangeStart("1")}${run(xml)}${rangeEnd("1")}`), comment("1", "Editor", "Note."));

    const result = convertDocx(archive);

    expect(result).toEqual({
      markdown: `${prose}{>>@Editor: Note.<<}\n`,
      comments: 1,
      highlights: 0,
    });
  });
});

describe("audit: comments survive exactly once", () => {
  test("a comment no range points at is kept as a point comment at the end", () => {
    const archive = docx(
      paragraph(`${run("Text.")}<w:r><w:commentReference w:id="1"/></w:r>`),
      comment("1", "Editor", "Point note."),
    );

    const result = convertDocx(archive);

    expect(result).toEqual({
      markdown: "Text.\n\n{>>@Editor: Point note.<<}\n",
      comments: 1,
      highlights: 0,
    });
  });

  test("a doubled range end emits its comment once", () => {
    const archive = docx(
      paragraph(`${rangeStart("1")}${run("anchor")}${rangeEnd("1")}${run(" tail")}${rangeEnd("1")}`),
      comment("1", "Editor", "Once."),
    );

    const result = convertDocx(archive);

    expect(result).toEqual({
      markdown: "{==anchor==}{>>@Editor: Once.<<} tail\n",
      comments: 1,
      highlights: 1,
    });
  });

  test("a range end before its start emits its comment once", () => {
    const archive = docx(
      paragraph(`${rangeEnd("1")}${run("before ")}${rangeStart("1")}${run("after")}`),
      comment("1", "Editor", "Once."),
    );

    const result = convertDocx(archive);

    expect(result).toEqual({
      markdown: "{>>@Editor: Once.<<}before after\n",
      comments: 1,
      highlights: 0,
    });
  });
});

describe("audit: malformed input is refused", () => {
  test.each([
    { name: "closed", body: paragraph(`${rangeStart("1")}${run("anchor")}${rangeEnd("1")}`) },
    { name: "unclosed", body: paragraph(`${rangeStart("1")}${run("anchor")}`) },
  ])("$name range naming a comment that does not exist is refused", ({ body }) => {
    const archive = docx(body, comment("2", "Editor", "A different comment."));

    expect(() => convertDocx(archive)).toThrow("comment 1 has no entry in word/comments.xml");
  });

  test("two comments sharing an id are refused instead of dropping one", () => {
    const archive = docx(
      paragraph(`${rangeStart("1")}${run("anchor")}${rangeEnd("1")}`),
      `${comment("1", "First", "Lost if the second wins.")}${comment("1", "Second", "Replaces it.")}`,
    );

    expect(() => convertDocx(archive)).toThrow("word/comments.xml: duplicate comment id 1");
  });

  test("acm import refuses a document with no text and writes nothing", async () => {
    const dir = temporaryDirectory();
    const source = join(dir, "empty.docx");
    const output = join(dir, "empty.md");
    writeFileSync(source, docx("<w:p/>"));

    const child = Bun.spawn([process.execPath, CLI, "import", source], {
      env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, "xdg") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect({ exitCode, stderr }).toEqual({ exitCode: 1, stderr: "acm import: document has no text to import\n" });
    expect(existsSync(output)).toBe(false);
  }, 60_000);
});
