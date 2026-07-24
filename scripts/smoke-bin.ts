import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";

const binary = resolve(import.meta.dir, `../dist/${process.platform === "win32" ? "acm.exe" : "acm"}`);
const dir = mkdtempSync(join(tmpdir(), "acm-bin-smoke-"));

try {
  const source = join(dir, "google-export.docx");
  const output = join(dir, "google-export.md");
  const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const documentXml = `<?xml version="1.0"?>
    <w:document xmlns:w="${wordNamespace}"><w:body><w:p>
      <w:commentRangeStart w:id="1"/><w:r><w:t>Standalone import.</w:t></w:r><w:commentRangeEnd w:id="1"/>
    </w:p></w:body></w:document>`;
  const commentsXml = `<?xml version="1.0"?>
    <w:comments xmlns:w="${wordNamespace}"><w:comment w:id="1" w:author="QA">
      <w:p><w:r><w:t>Embedded comment.</w:t></w:r></w:p>
    </w:comment></w:comments>`;
  writeFileSync(
    source,
    zipSync({
      "word/document.xml": strToU8(documentXml),
      "word/comments.xml": strToU8(commentsXml),
    }),
  );

  const imported = Bun.spawnSync([binary, "import", source, output], {
    cwd: dir, // no node_modules anywhere above the compiled binary's working directory
    env: { ...process.env, HOME: dir },
  });
  if (imported.exitCode !== 0) {
    throw new Error(`compiled import failed:\n${imported.stderr.toString()}`);
  }
  const expected = "{==Standalone import.==}{>>@QA: Embedded comment.<<}\n";
  if (readFileSync(output, "utf8") !== expected) {
    throw new Error("compiled import output did not preserve the anchored comment");
  }

  const help = Bun.spawnSync([binary, "--help"], { cwd: dir });
  if (help.exitCode !== 0 || !help.stdout.toString().includes("Google Docs URL|file.docx")) {
    throw new Error("compiled CLI help is missing the Google Docs importer");
  }
  console.log("compiled binary smoke: import + help passed outside node_modules");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
