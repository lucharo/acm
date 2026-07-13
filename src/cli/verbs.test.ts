// CLI verb dispatch — the reply/apply spellings (the pure edit semantics live in
// lib/agentEdits.test.ts; these pin the dispatch layer: bare reply vs --batch vs
// the deprecated `apply` alias). Spawned as real CLI runs because usage errors
// process.exit; every doc is a temp file passed via --doc, so no editor probing.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../../cli.ts");
const DOC = 'Prose under review.{>>@luis: is this clear?<<}\n';
const EDITS = [{ id: "t1", match: "is this clear?", insert: "{>>@claude: yes<<}" }];

let dir: string;
let doc: string;
let edits: string;

function run(...args: string[]) {
  const env = { ...process.env };
  delete env.ACM_AUTHOR; // tests assert the default @claude author
  const p = Bun.spawnSync(["bun", CLI, ...args, "--doc", doc], { cwd: resolve(import.meta.dir, "../.."), env });
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
