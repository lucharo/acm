import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { convertDocx, downloadGoogleDocsDocx, googleDocsExportUrl, importDocument } from "./docxImport";
import { scanTokens } from "../lib/criticmarkup";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
function docx(documentBody: string, comments = ""): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="${WORD_NS}"><w:body>${documentBody}</w:body></w:document>`,
    ),
  };
  if (comments) {
    files["word/comments.xml"] = strToU8(
      `<?xml version="1.0"?><w:comments xmlns:w="${WORD_NS}">${comments}</w:comments>`,
    );
  }
  return zipSync(files);
}

describe("Google Docs imports", () => {
  test("turns a normal Google Docs sharing URL into its DOCX export URL", () => {
    expect(
      googleDocsExportUrl(
        "https://docs.google.com/document/d/1AbC_def-234/edit?tab=t.0#heading=h.example",
      ).toString(),
    ).toBe("https://docs.google.com/document/d/1AbC_def-234/export?format=docx");
  });

  test("downloads the DOCX export and keeps Google's document filename", async () => {
    let requested = "";
    const result = await downloadGoogleDocsDocx(
      "https://docs.google.com/document/d/doc-123/edit",
      async (input) => {
        requested = String(input);
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          headers: { "Content-Disposition": 'attachment; filename="Launch review.docx"' },
        });
      },
    );

    expect(requested).toBe("https://docs.google.com/document/d/doc-123/export?format=docx");
    expect(result.filename).toBe("Launch review.docx");
    expect(result.bytes).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  });

  test("explains that a private Google Doc must be downloaded first", async () => {
    await expect(
      downloadGoogleDocsDocx(
        "https://docs.google.com/document/d/private-doc/edit",
        async () => new Response("Forbidden", { status: 403 }),
      ),
    ).rejects.toThrow("download it as .docx");
  });

  test("imports a Google Docs URL into the requested Markdown file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-google-doc-"));
    temporaryDirectories.push(dir);
    const output = join(dir, "launch.md");
    const archive = zipSync({
      "word/document.xml": strToU8(`<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p><w:r><w:t>Imported from Google Docs.</w:t></w:r></w:p></w:body>
        </w:document>`),
    });

    await importDocument(
      "https://docs.google.com/document/d/doc-123/edit",
      output,
      async () => new Response(archive),
    );

    expect(readFileSync(output, "utf8")).toBe("Imported from Google Docs.\n");
  });

  test("preserves headings, lists, insertions, and deletions from the DOCX", async () => {
    const result = convertDocx(
      docx(`
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Review</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First point</w:t></w:r></w:p>
        <w:p><w:r><w:t>Keep </w:t></w:r><w:ins><w:r><w:t>added</w:t></w:r></w:ins><w:del><w:r><w:delText>removed</w:delText></w:r></w:del></w:p>
      `),
    );

    expect(result.markdown).toBe(
      "# Review\n\n- First point\n\nKeep {++added++}{--removed--}\n",
    );
  });

  test("preserves Word tabs and both line-break element forms", () => {
    const result = convertDocx(
      docx(`<w:p><w:r><w:t>first</w:t><w:tab/><w:t>second</w:t><w:br/><w:t>third</w:t><w:cr/><w:t>fourth</w:t></w:r></w:p>`),
    );

    expect(result.markdown).toBe("first\tsecond\nthird\nfourth\n");
  });

  test("anchors a multi-paragraph comment to its final paragraph", () => {
    const result = convertDocx(
      docx(
        `<w:p><w:commentRangeStart w:id="9"/><w:r><w:t>First paragraph.</w:t></w:r></w:p>
         <w:p><w:r><w:t>Final paragraph.</w:t></w:r><w:commentRangeEnd w:id="9"/></w:p>`,
        `<w:comment w:id="9" w:author="Editor"><w:p><w:r><w:t>One comment across both.</w:t></w:r></w:p></w:comment>`,
      ),
    );

    expect(result.markdown).toBe(
      "First paragraph.\n\n{==Final paragraph.==}{>>@Editor: One comment across both.<<}\n",
    );
  });

  test("places a comment closing inside a tracked change after the change", () => {
    const result = convertDocx(
      docx(
        `<w:p><w:ins><w:commentRangeStart w:id="3"/><w:r><w:t>new wording</w:t></w:r><w:commentRangeEnd w:id="3"/></w:ins></w:p>`,
        `<w:comment w:id="3" w:author="Editor"><w:p><w:r><w:t>Suggested here.</w:t></w:r></w:p></w:comment>`,
      ),
    );

    expect(result.markdown).toBe("{++new wording++}{>>@Editor: Suggested here.<<}\n");
  });

  test("degrades an unbalanced cross-change anchor to a point comment", () => {
    const result = convertDocx(
      docx(
        `<w:p><w:ins><w:commentRangeStart w:id="4"/><w:r><w:t>new</w:t></w:r></w:ins><w:r><w:t> wording</w:t></w:r><w:commentRangeEnd w:id="4"/></w:p>`,
        `<w:comment w:id="4" w:author="Editor"><w:p><w:r><w:t>Crosses a boundary.</w:t></w:r></w:p></w:comment>`,
      ),
    );

    expect(result.markdown).toBe("{++new++} wording{>>@Editor: Crosses a boundary.<<}\n");
  });

  test("keeps the first anchor when a DOCX repeats a comment-range start", () => {
    const result = convertDocx(
      docx(
        `<w:p><w:commentRangeStart w:id="5"/><w:r><w:t>Whole </w:t></w:r><w:commentRangeStart w:id="5"/><w:r><w:t>anchor</w:t></w:r><w:commentRangeEnd w:id="5"/></w:p>`,
        `<w:comment w:id="5" w:author="Editor"><w:p><w:r><w:t>Duplicate range.</w:t></w:r></w:p></w:comment>`,
      ),
    );

    expect(result.markdown).toBe("{==Whole anchor==}{>>@Editor: Duplicate range.<<}\n");
  });

  test("keeps a comment whose range never closes as a point comment at EOF", () => {
    const result = convertDocx(
      docx(
        `<w:p><w:commentRangeStart w:id="6"/><w:r><w:t>Text survives.</w:t></w:r></w:p>`,
        `<w:comment w:id="6" w:author="Editor"><w:p><w:r><w:t>Unclosed range.</w:t></w:r></w:p></w:comment>`,
      ),
    );

    expect(result.markdown).toBe("Text survives.\n\n{>>@Editor: Unclosed range.<<}\n");
  });

  test.each([
    {
      name: "nested",
      body: `<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>outer </w:t></w:r><w:commentRangeStart w:id="2"/><w:r><w:t>inner</w:t></w:r><w:commentRangeEnd w:id="2"/><w:commentRangeEnd w:id="1"/></w:p>`,
      expected: "outer inner{>>@Inner: Inner note.<<}{>>@Outer: Outer note.<<}\n",
    },
    {
      name: "overlapping",
      body: `<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>first </w:t></w:r><w:commentRangeStart w:id="2"/><w:r><w:t>shared</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:t> second</w:t></w:r><w:commentRangeEnd w:id="2"/></w:p>`,
      expected: "first shared{>>@Outer: Outer note.<<} second{>>@Inner: Inner note.<<}\n",
    },
  ])("degrades $name comment ranges to valid point comments", ({ body, expected }) => {
    const result = convertDocx(
      docx(
        body,
        `<w:comment w:id="1" w:author="Outer"><w:p><w:r><w:t>Outer note.</w:t></w:r></w:p></w:comment>
         <w:comment w:id="2" w:author="Inner"><w:p><w:r><w:t>Inner note.</w:t></w:r></w:p></w:comment>`,
      ),
    );

    expect(result.markdown).toBe(expected);
    expect(scanTokens(result.markdown).filter((token) => token.type === "comment")).toHaveLength(2);
  });

  test("keeps a literal comment close marker inside the imported comment body", () => {
    const result = convertDocx(
      docx(
        `<w:p><w:r><w:t>Text.</w:t></w:r><w:commentRangeStart w:id="7"/><w:commentRangeEnd w:id="7"/></w:p>`,
        `<w:comment w:id="7" w:author="Editor"><w:p><w:r><w:t>Use &lt;&lt;} literally.</w:t></w:r></w:p></w:comment>`,
      ),
    );
    const comments = scanTokens(result.markdown).filter((token) => token.type === "comment");

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: "Editor", body: "Use <<} literally." });
  });

  test("preserves tabs and line breaks inside imported comment bodies", () => {
    const result = convertDocx(
      docx(
        `<w:p><w:r><w:t>Text.</w:t></w:r><w:commentRangeStart w:id="8"/><w:commentRangeEnd w:id="8"/></w:p>`,
        `<w:comment w:id="8" w:author="Editor"><w:p><w:r><w:t>first</w:t><w:tab/><w:t>second</w:t><w:br/><w:t>third</w:t><w:cr/><w:t>fourth</w:t></w:r></w:p></w:comment>`,
      ),
    );
    const comments = scanTokens(result.markdown).filter((token) => token.type === "comment");

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      author: "Editor",
      body: "first\tsecond\nthird\nfourth",
    });
  });

  test("omits tracked-deleted text while retaining inserted text in comment bodies", () => {
    const result = convertDocx(
      docx(
        `<w:p><w:r><w:t>Text.</w:t></w:r><w:commentRangeStart w:id="10"/><w:commentRangeEnd w:id="10"/></w:p>`,
        `<w:comment w:id="10" w:author="Editor"><w:p><w:r><w:t>Keep </w:t></w:r><w:del><w:r><w:tab/><w:delText>removed</w:delText><w:br/><w:cr/></w:r></w:del><w:ins><w:r><w:t>inserted</w:t></w:r></w:ins></w:p></w:comment>`,
      ),
    );
    const comments = scanTokens(result.markdown).filter((token) => token.type === "comment");

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: "Editor", body: "Keep inserted" });
  });

  test("refuses an output path that could overwrite the source DOCX", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-docx-output-"));
    temporaryDirectories.push(dir);
    const source = join(dir, "review.docx");
    const archive = docx(`<w:p><w:r><w:t>Keep the source.</w:t></w:r></w:p>`);
    writeFileSync(source, archive);

    await expect(importDocument(source, source)).rejects.toThrow("output must be a .md file");
    expect(readFileSync(source)).toEqual(Buffer.from(archive));
  });
});
