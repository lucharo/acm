// CLI verb dispatch — the reply/apply spellings (the pure edit semantics live in
// lib/agentEdits.test.ts; these pin the dispatch layer: bare reply vs --batch vs
// the deprecated `apply` alias). Spawned as real CLI runs because usage errors
// process.exit; every doc is a temp file passed via --doc, so no editor probing.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";

const CLI = resolve(import.meta.dir, "../../cli.ts");
const DOC = 'Prose under review.{>>@luis: is this clear?<<}\n';
const EDITS = [{ id: "t1", match: "is this clear?", insert: "{>>@claude: yes<<}" }];

let dir: string;
let doc: string;
let edits: string;

function run(...args: string[]) {
  const env = { ...process.env };
  delete env.ACM_AUTHOR; // tests assert the default @claude author
  // timeout bounds a dispatch regression: if a verb ever falls out of VERBS,
  // cli.ts treats it as a filename and starts a long-lived server — spawnSync
  // would block forever and wedge the suite instead of failing. Fail fast.
  const p = Bun.spawnSync(["bun", CLI, ...args, "--doc", doc], { cwd: resolve(import.meta.dir, "../.."), env, timeout: 15_000 });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acm-verbs-"));
  doc = join(dir, "doc.md");
  edits = join(dir, "edits.json");
  writeFileSync(doc, DOC);
  writeFileSync(edits, JSON.stringify(EDITS));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("acm reply dispatch", () => {
  test("bare reply threads a comment onto the matched thread (comment alias)", () => {
    const r = run("reply", "is this clear?", "yes — resolving");
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toContain("<<}{>>@claude: yes — resolving<<}");
    expect(r.out).toContain("acm reply: replied to");
  });

  test("comment alias threads the same single reply (and stays registered in VERBS)", () => {
    const r = run("comment", "is this clear?", "ack");
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toContain("<<}{>>@claude: ack<<}");
    // pins the cmd-for-messages contract: the alias reports itself as `comment`,
    // not the internal `op` name it dispatches to.
    expect(r.out).toContain("acm comment: replied to");
  });

  test("reply --batch applies the edits.json batch", () => {
    const r = run("reply", "--batch", edits);
    expect(r.code).toBe(0);
    expect(r.out).toContain("applied 1/1");
    expect(readFileSync(doc, "utf8")).toContain("{>>@claude: yes<<}");
  });

  test("reply --batch re-run skips idempotently", () => {
    run("reply", "--batch", edits);
    const r = run("reply", "--batch", edits);
    expect(r.code).toBe(0);
    expect(r.out).toContain("skipped 1 (idempotent)");
  });

  test("deprecated `apply <edits.json>` still batches, with a stderr notice", () => {
    const r = run("apply", edits);
    expect(r.code).toBe(0);
    expect(r.err).toContain("deprecated");
    expect(readFileSync(doc, "utf8")).toContain("{>>@claude: yes<<}");
  });

  test("`apply --batch <edits.json>` (the advertised migration, half-taken) also works", () => {
    const r = run("apply", "--batch", edits);
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toContain("{>>@claude: yes<<}");
  });

  test("bare reply with missing args exits non-zero with reply-spelled usage", () => {
    const r = run("reply", "only-a-phrase");
    expect(r.code).toBe(1);
    expect(r.err).toContain('usage: acm reply "<phrase>" "<text>"');
  });
});

describe("acm import", () => {
  test("imports an exported Google Doc DOCX with comments without an external converter", () => {
    const source = join(dir, "review.docx");
    const output = join(dir, "review.md");
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:commentRangeStart w:id="7"/>
            <w:r><w:t>Keep this sentence.</w:t></w:r>
            <w:commentRangeEnd w:id="7"/>
          </w:p>
        </w:body>
      </w:document>`;
    const commentsXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:comment w:id="7" w:author="Luis"><w:p><w:r><w:t>Make this clearer.</w:t></w:r></w:p></w:comment>
      </w:comments>`;
    writeFileSync(
      source,
      zipSync({
        "word/document.xml": strToU8(documentXml),
        "word/comments.xml": strToU8(commentsXml),
      }),
    );

    const env: Record<string, string | undefined> = { ...process.env, HOME: dir };
    delete env.ACM_CONVERTER;
    const p = Bun.spawnSync(["bun", CLI, "import", source, output], {
      cwd: resolve(import.meta.dir, "../.."),
      env,
      timeout: 15_000,
    });

    expect(p.exitCode).toBe(0);
    expect(p.stderr.toString()).toBe("");
    expect(readFileSync(output, "utf8")).toBe(
      "{==Keep this sentence.==}{>>@Luis: Make this clearer.<<}\n",
    );
    expect(p.stdout.toString()).toContain("comments: 1 (1 anchored, 0 point)");
    expect(p.stdout.toString()).toContain("markup diagnostics: 0 (clean)");
  });
});
