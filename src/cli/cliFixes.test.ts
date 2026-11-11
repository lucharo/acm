// ── CLI defects from the 2026-11 editing-API audit (#89 #99 #100 #101 #102 #103 #105 #106) ──
// Each test mirrors the repro in its issue. Every server and CLI run uses a temp
// XDG_CONFIG_HOME and temp documents.

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../../server";
import type { AcmServer } from "../../server";
import { recordHistory, listHistory, showVersion } from "../server/history";
import { addSuggestion, addSuggestionsAt } from "../lib/agentEdits";
import { scanTokens, suggestCards } from "../lib/criticmarkup";
import type { CommentToken } from "../lib/types";
import { readDocumentProvenance } from "../server/provenance";

/** Source and operation of the last provenance event recorded for `doc`. */
async function lastWrite(doc: string) {
  const e = (await readDocumentProvenance(doc, readFileSync(doc, "utf8"))).events.at(-1);
  return { source: e?.source, operation: e?.operation };
}

setDefaultTimeout(30_000); // every test spawns the CLI (and git); slow under load

const CLI = resolve(import.meta.dir, "../../cli.ts");
const J = { "content-type": "application/json" };
const live: AcmServer[] = [];
let prevXdg: string | undefined;
let xdg: string;

beforeAll(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  xdg = mkdtempSync(join(tmpdir(), "acm-clifix-xdg-"));
  process.env.XDG_CONFIG_HOME = xdg;
});
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
});
afterEach(() => {
  while (live.length) live.pop()!.stop();
});

async function boot(seed: string, docPath?: string) {
  const path = docPath ?? join(mkdtempSync(join(tmpdir(), "acm-clifix-doc-")), "doc.md");
  await Bun.write(path, seed);
  const srv = startServer({ docPath: path, port: 0, staticDir: "./dist" });
  live.push(srv);
  const url = `http://127.0.0.1:${srv.server.port}`;
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${url}/api/doc`);
      if (r.ok) {
        const s = (await r.json()) as { path: string; serverEpoch: string };
        return { url, docPath: path, path: s.path, epoch: s.serverEpoch };
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(10);
  }
  throw new Error("test server failed to start");
}
type Booted = Awaited<ReturnType<typeof boot>>;

const put = async (b: Booted, baseVersion: number, content: string) =>
  (await fetch(`${b.url}/api/doc`, {
    method: "PUT",
    headers: J,
    body: JSON.stringify({ documentPath: b.path, serverEpoch: b.epoch, baseVersion, content }),
  })).status;
const presence = (b: Booted, from: number, to: number) =>
  fetch(`${b.url}/api/presence`, { method: "PUT", headers: J, body: JSON.stringify({ documentPath: b.path, from, to }) });

/** Wait until the server's fire-and-forget registerInstance has landed. */
async function registered(port: string) {
  for (let i = 0; i < 100; i++) {
    try {
      const all = JSON.parse(readFileSync(join(xdg, "acm", "instances.json"), "utf8")) as Record<string, unknown>;
      if (all[port]) return;
    } catch {
      /* not written yet */
    }
    await Bun.sleep(20);
  }
  throw new Error(`instance :${port} never registered`);
}

/** The ref of the doc's oldest recorded version. The server records its boot
 *  baseline in the background, so poll rather than race it with a second commit. */
async function firstVersion(docPath: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const entries = await listHistory(docPath);
    if (entries.length > 0) return entries.at(-1)!.split(/\s+/)[0];
    await Bun.sleep(20);
  }
  throw new Error("no history recorded");
}

/** Run the CLI asynchronously: the test servers live in THIS process, so a
 *  blocking spawnSync would stall them and every live write would time out. */
async function cli(args: string[], env: Record<string, string> = {}, cwd?: string) {
  // A generous live-write ceiling: on a loaded machine the default 10 s can expire
  // before the in-process server answers, turning a cursor refusal into a timeout.
  const e: Record<string, string | undefined> = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    ACM_AGENT_WRITE_TIMEOUT_MS: "25000",
    ...env,
  };
  delete e.ACM_AUTHOR;
  if (!("ACM_DOC" in env)) delete e.ACM_DOC;
  const p = Bun.spawn(["bun", CLI, ...args], {
    cwd: cwd ?? resolve(import.meta.dir, "../.."),
    env: e,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 28_000,
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
}

const THREAD = "Intro {==one==}{>>@luis: hmm<<} tail.\n";

describe("#89 acm restore never hands a ref to git as an option", () => {
  test("showVersion of an option-shaped ref is null and leaves the document untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-restore-"));
    const doc = join(dir, "r.md");
    writeFileSync(doc, "Hello world, keep me.\nLine two.\n");
    await recordHistory(doc, "open");
    expect(await showVersion(doc, `--output=${doc}`)).toBeNull();
    expect(readFileSync(doc, "utf8")).toBe("Hello world, keep me.\nLine two.\n");
  });

  test("an option-shaped ref is refused and the document is untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-restore-"));
    const doc = join(dir, "r.md");
    writeFileSync(doc, "Hello world, keep me.\nLine two.\n");
    await recordHistory(doc, "open");
    const r = await cli(["restore", "--output=r.md", "--doc", doc], {}, dir);
    expect({ code: r.code, disk: readFileSync(doc, "utf8") }).toEqual({ code: 1, disk: "Hello world, keep me.\nLine two.\n" });
  });

  test("a real ref still restores", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-restore-"));
    const doc = join(dir, "r.md");
    writeFileSync(doc, "Version one.\n");
    await recordHistory(doc, "open");
    const ref = (await listHistory(doc)).at(-1)!.split(/\s+/)[0];
    writeFileSync(doc, "Version two.\n");
    const r = await cli(["restore", ref, "--doc", doc]);
    expect({ code: r.code, disk: readFileSync(doc, "utf8") }).toEqual({ code: 0, disk: "Version one.\n" });
    expect(await lastWrite(doc)).toEqual({ source: "restore", operation: "restore" });
  });
});

describe("#100 acm restore on a live document goes through its server", () => {
  test("refused under the human's cursor, the human's text kept", async () => {
    const b = await boot("First version.\n");
    const ref = await firstVersion(b.docPath);
    const edited = "Second version typed by the human.\n";
    expect(await put(b, 0, edited)).toBe(200);
    await registered(new URL(b.url).port);
    await presence(b, 0, 10_000);
    const r = await cli(["restore", ref, "--doc", b.docPath]);
    expect({ code: r.code, disk: readFileSync(b.docPath, "utf8") }).toEqual({ code: 1, disk: edited });
    expect(r.out).toContain("the human's cursor is in that span");
  });

  test("with no cursor in the way, the restore lands via the live editor", async () => {
    const b = await boot("First version.\n");
    const ref = await firstVersion(b.docPath);
    expect(await put(b, 0, "Second version.\n")).toBe(200);
    await registered(new URL(b.url).port);
    const r = await cli(["restore", ref, "--doc", b.docPath]);
    expect({ code: r.code, disk: readFileSync(b.docPath, "utf8") }).toEqual({ code: 0, disk: "First version.\n" });
    expect(r.out).toContain("written via the live editor");
    expect(await lastWrite(b.docPath)).toEqual({ source: "restore", operation: "restore" });
  });
});

describe("#99 a differently spelled path to a live document still routes through its server", () => {
  test("the real path of a doc the editor opened through a symlink hits the cursor guard", async () => {
    const real = mkdtempSync(join(tmpdir(), "acm-clifix-real-"));
    const alias = join(mkdtempSync(join(tmpdir(), "acm-clifix-alias-")), "link");
    symlinkSync(real, alias);
    const b = await boot(THREAD, join(alias, "doc.md"));
    await registered(new URL(b.url).port);
    await presence(b, 0, 10_000);
    const r = await cli(["reply", "hmm", "via real path", "--doc", join(real, "doc.md")]);
    expect({ code: r.code, disk: readFileSync(join(real, "doc.md"), "utf8") }).toEqual({ code: 1, disk: THREAD });
  });

  test("with editors open on two spellings of one file, the exact spelling's editor is used", async () => {
    const real = mkdtempSync(join(tmpdir(), "acm-clifix-real-"));
    const alias = join(mkdtempSync(join(tmpdir(), "acm-clifix-alias-")), "link");
    symlinkSync(real, alias);
    const viaAlias = await boot(THREAD, join(alias, "doc.md"));
    const viaReal = await boot(THREAD, join(real, "doc.md"));
    await registered(new URL(viaAlias.url).port);
    await registered(new URL(viaReal.url).port);
    // Whichever port is lower, one of the two cases below would pick the other editor.
    for (const [owner, other, doc] of [
      [viaReal, viaAlias, join(real, "doc.md")],
      [viaAlias, viaReal, join(alias, "doc.md")],
    ] as const) {
      await presence(other, 99_999, 99_999); // cursor away from the text
      await presence(owner, 0, 10_000); // cursor over the whole doc
      const r = await cli(["reply", "hmm", "two editors", "--doc", doc]);
      expect({ code: r.code, disk: readFileSync(join(real, "doc.md"), "utf8") }).toEqual({ code: 1, disk: THREAD });
      expect(r.out).toContain("the human's cursor is in that span");
    }
  });

  test("a relative path to the live document routes through it and lands", async () => {
    const b = await boot(THREAD);
    await registered(new URL(b.url).port);
    const r = await cli(["reply", "hmm", "via relative path", "--doc", "doc.md"], {}, join(b.docPath, ".."));
    expect(r.code).toBe(0);
    expect(r.out).toContain("written via the live editor");
    expect(readFileSync(b.docPath, "utf8")).toContain("via relative path");
  });
});

describe("#101 a timed-out live write reports an unknown outcome", () => {
  test("the CLI does not claim nothing was written", async () => {
    const docPath = join(mkdtempSync(join(tmpdir(), "acm-clifix-doc-")), "doc.md");
    writeFileSync(docPath, THREAD);
    // Accepts connections, never answers: the write's outcome can't be known.
    const blackhole = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const cfg = join(xdg, "acm");
    mkdirSync(cfg, { recursive: true });
    const prev = (() => {
      try {
        return readFileSync(join(cfg, "instances.json"), "utf8");
      } catch {
        return "{}";
      }
    })();
    writeFileSync(
      join(cfg, "instances.json"),
      JSON.stringify({ [String(blackhole.port)]: { port: blackhole.port, doc: docPath, pid: process.pid, startedAt: "2026-11-06T00:00:00Z" } }),
    );
    try {
      const r = await cli(["reply", "hmm", "timeout probe", "--doc", docPath], { ACM_AGENT_WRITE_TIMEOUT_MS: "1000" });
      expect(r.code).toBe(1);
      expect(r.out).not.toContain("Nothing written");
      expect(r.out).toContain("may still have applied it");
      expect(r.out).toContain("acm threads");
    } finally {
      blackhole.stop(true);
      writeFileSync(join(cfg, "instances.json"), prev);
    }
  });
});

describe("#101 a live write whose response is cut off reports an unknown outcome", () => {
  test("headers arrive, the body never finishes: no 'Nothing written'", async () => {
    const docPath = join(mkdtempSync(join(tmpdir(), "acm-clifix-doc-")), "doc.md");
    writeFileSync(docPath, THREAD);
    // Answers the probe, then sends 200 + a partial JSON body that never ends.
    const editor = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/api/agent-write"
          ? new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode('{"version":'));
                },
              }),
              { headers: { "content-type": "application/json" } },
            )
          : Response.json({}),
    });
    const cfg = join(xdg, "acm");
    mkdirSync(cfg, { recursive: true });
    const registry = join(cfg, "instances.json");
    let prev = "{}";
    try {
      prev = readFileSync(registry, "utf8");
    } catch {
      /* no registry yet */
    }
    writeFileSync(registry, JSON.stringify({ [String(editor.port)]: { port: editor.port, doc: docPath, pid: process.pid, startedAt: "2026-11-06T00:00:00Z" } }));
    try {
      const r = await cli(["reply", "hmm", "cut off", "--doc", docPath], { ACM_AGENT_WRITE_TIMEOUT_MS: "1000" });
      expect(r.code).toBe(1);
      expect(r.out).not.toContain("Nothing written");
      expect(r.out).toContain("may still have applied it");
    } finally {
      editor.stop(true);
      writeFileSync(registry, prev);
    }
  });
});

describe("#27 a write merged by the live editor is linted on the merged bytes", () => {
  /** Run `acm <args>` against a fake live editor whose merge is `merge(content)`;
   *  returns the CLI result and the merged bytes the editor answered with. */
  async function viaMergingEditor(seed: string, merge: (content: string) => string, args: string[]) {
    const docPath = join(mkdtempSync(join(tmpdir(), "acm-clifix-doc-")), "doc.md");
    writeFileSync(docPath, seed);
    let merged = "";
    const editor = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.method !== "POST" || (path !== "/api/agent-write" && path !== "/api/decisions")) return Response.json({});
        const body = (await req.json()) as { content?: string; decisionEvents?: { id: string }[] };
        // Persist review decisions as the real editor does, so accept/reject run too.
        const audit = { status: "persisted", decisionEventIds: (body.decisionEvents ?? []).map((e) => e.id) };
        if (path === "/api/decisions") return Response.json({ audit });
        merged = merge(body.content ?? "");
        return Response.json({ version: 2, content: merged, audit });
      },
    });
    const cfg = join(xdg, "acm");
    mkdirSync(cfg, { recursive: true });
    const registry = join(cfg, "instances.json");
    let prev = "{}";
    try {
      prev = readFileSync(registry, "utf8");
    } catch {
      /* no registry yet */
    }
    writeFileSync(registry, JSON.stringify({ [String(editor.port)]: { port: editor.port, doc: docPath, pid: process.pid, startedAt: "2026-11-11T00:00:00Z" } }));
    try {
      const r = await cli([...args, "--doc", docPath]);
      expect(r.out).toContain("written via the live editor");
      return { ...r, merged };
    } finally {
      editor.stop(true);
      writeFileSync(registry, prev);
    }
  }
  const warningLines = (out: string) => out.split("\n").filter((l) => l.startsWith("  line ") || l.includes("warning:"));
  const ANCHORED = "Intro.\n\n## {==Wrapping up==}{>>@luis: weak heading<<}\n\nBody.\n";
  const POINT = "Intro.\n\n## Wrapping up{>>@luis: weak heading<<}\n\nBody.\n";

  test("the warning names the merged line, and a problem the person typed meanwhile is not blamed on the write", async () => {
    // The person typed two lines, one with an unclosed highlight, while the write
    // was in flight: the editor's merge puts them above the agent's reply.
    const r = await viaMergingEditor(ANCHORED, (content) => `Human {==typing\n\n${content}`, [
      "reply",
      "weak heading",
      "@claude: SUGGEST: Two threads",
    ]);

    const comments = scanTokens(r.merged).filter((t): t is CommentToken => t.type === "comment");
    const reply = comments.find((c) => c.body.startsWith("@claude:"));
    expect(reply).toBeDefined();
    expect(r.code).toBe(0);
    expect(warningLines(r.out)).toEqual([
      "acm reply: warning: this write added 1 problem the editor will flag. It is written; fix it before the person reviews it:",
      `  line 5, thread #${comments[0].id} on ⟦Wrapping up⟧, comment #${reply!.id} "@claude: SUGGEST: Two threads": ` +
        'its text starts with "@claude:", which acm already writes as the author, so the SUGGEST: behind it is hidden and it shows as a plain note with no Apply — start the text with "SUGGEST:"',
    ]);
    expect(r.out).toContain("  comments: 2 | applicable SUGGEST cards: 0 | ⚠ 1 new SUGGEST won't apply\n");
  });

  test("a SUGGEST the merge gave a span (the person highlighted it meanwhile) is not warned about", async () => {
    const r = await viaMergingEditor(POINT, (content) => content.replace("## Wrapping up{>>", "## {==Wrapping up==}{>>"), [
      "reply",
      "weak heading",
      "SUGGEST: Two threads",
    ]);

    expect(r.code).toBe(0);
    expect(r.merged).toContain("## {==Wrapping up==}{>>@luis: weak heading<<}{>>@claude: SUGGEST: Two threads<<}");
    expect(warningLines(r.out)).toEqual([]);
    expect(r.out).toContain("  comments: 2 | applicable SUGGEST cards: 1\n");
  });

  test("an existing SUGGEST the write left without a span is still warned about after an unrelated merge", async () => {
    // Accepting a two-paragraph replacement drops the anchor, so the competing
    // SUGGEST in the same thread is left with nothing to apply to.
    const seed =
      "Intro.\n\nKeep {==this span==}{>>@claude: ~acm1~SUGGEST: para one\\n\\npara two<<}{>>@luis: SUGGEST: other words<<} end.\n";
    const r = await viaMergingEditor(seed, (content) => `Human line.\n\n${content}`, ["accept", "para one"]);

    const comments = scanTokens(r.merged).filter((t): t is CommentToken => t.type === "comment");
    expect(r.code).toBe(0);
    expect(r.merged).toBe("Human line.\n\nIntro.\n\nKeep para one\n\npara two{>>@luis: SUGGEST: other words<<} end.\n");
    expect(warningLines(r.out)).toEqual([
      "acm accept: warning: this write added 1 problem the editor will flag. It is written; fix it before the person reviews it:",
      `  line 7, thread #${comments[0].id} (point comment, no span) "SUGGEST: other words": ` +
        "SUGGEST card has no anchored span, so it can't be applied — put {==the span==} right before it",
    ]);
  });

  test("a SUGGEST the merge left without a span (the person removed the highlight meanwhile) is warned about", async () => {
    const r = await viaMergingEditor(ANCHORED, (content) => content.replace("## {==Wrapping up==}{>>", "## Wrapping up{>>"), [
      "reply",
      "weak heading",
      "SUGGEST: Two threads",
    ]);

    const comments = scanTokens(r.merged).filter((t): t is CommentToken => t.type === "comment");
    expect(r.code).toBe(0);
    expect(r.merged).toContain("## Wrapping up{>>@luis: weak heading<<}{>>@claude: SUGGEST: Two threads<<}");
    expect(warningLines(r.out)).toEqual([
      "acm reply: warning: this write added 1 problem the editor will flag. It is written; fix it before the person reviews it:",
      `  line 3, thread #${comments[0].id} (point comment, no span), comment #${comments[1].id} "SUGGEST: Two threads": ` +
        'the thread it joins has no {==span==}, so this SUGGEST has nothing to apply to — anchor it with `acm suggest "<span>" "<new wording>"` instead',
    ]);
    expect(r.out).toContain("  comments: 2 | applicable SUGGEST cards: 0 | ⚠ 1 new SUGGEST won't apply\n");
  });
});

describe("#102 the --flag=value spelling", () => {
  test("--doc= and --author= are honoured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-flags-"));
    writeFileSync(join(dir, "named.md"), THREAD);
    writeFileSync(join(dir, "other.md"), THREAD);
    const r = await cli(["reply", "hmm", "hello", `--doc=${join(dir, "named.md")}`, "--author=bot"], { ACM_DOC: join(dir, "other.md") });
    expect({
      code: r.code,
      named: readFileSync(join(dir, "named.md"), "utf8"),
      other: readFileSync(join(dir, "other.md"), "utf8"),
    }).toEqual({
      code: 0,
      named: "Intro {==one==}{>>@luis: hmm<<}{>>@bot: hello<<} tail.\n",
      other: THREAD,
    });
  });

  test("an unknown flag is a usage error, nothing written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-flags-"));
    writeFileSync(join(dir, "d.md"), THREAD);
    const r = await cli(["reply", "hmm", "hello", "--docs", "x.md"], { ACM_DOC: join(dir, "d.md") });
    expect({ code: r.code, disk: readFileSync(join(dir, "d.md"), "utf8") }).toEqual({ code: 1, disk: THREAD });
    expect(r.out).toContain('unknown option "--docs"');
  });

  test("a value flag with no value is a usage error, nothing written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-flags-"));
    writeFileSync(join(dir, "d.md"), THREAD);
    for (const args of [["--doc"], ["--doc="], ["--doc", "--json"], ["--doc", "-r"]]) {
      const r = await cli(["reply", "hmm", "hello", ...args], { ACM_DOC: join(dir, "d.md") });
      expect({ args, code: r.code, disk: readFileSync(join(dir, "d.md"), "utf8") }).toEqual({ args, code: 1, disk: THREAD });
      expect(r.out).toContain("--doc needs a value");
    }
  });

  test("after `--`, an option-shaped word is plain text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-flags-"));
    const doc = join(dir, "d.md");
    writeFileSync(doc, "Use the --verbose switch.\n");
    const r = await cli(["suggest", "--doc", doc, "--", "--verbose", "`--verbose`"]);
    expect({ code: r.code, disk: readFileSync(doc, "utf8") }).toEqual({
      code: 0,
      disk: "Use the {==--verbose==}{>>@claude: SUGGEST: `--verbose`<<} switch.\n",
    });
  });
});

describe("#103 acm reply --batch exits non-zero when an item fails", () => {
  test("one good item, one unmatched: the good reply lands, exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-batch-"));
    const doc = join(dir, "b.md");
    writeFileSync(doc, THREAD);
    writeFileSync(join(dir, "e.json"), JSON.stringify([
      { id: "a", match: "hmm", insert: "{>>@claude: ok<<}" },
      { id: "b", match: "NOPE", insert: "{>>@claude: ok2<<}" },
    ]));
    const r = await cli(["reply", "--batch", join(dir, "e.json"), "--doc", doc]);
    expect({ code: r.code, disk: readFileSync(doc, "utf8") }).toEqual({
      code: 1,
      disk: "Intro {==one==}{>>@luis: hmm<<}{>>@claude: ok<<} tail.\n",
    });
  });

  test("an item without `insert` is reported as such, exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-batch-"));
    const doc = join(dir, "b.md");
    writeFileSync(doc, THREAD);
    writeFileSync(join(dir, "e.json"), JSON.stringify([{ id: "a", match: "hmm" }]));
    const r = await cli(["reply", "--batch", join(dir, "e.json"), "--doc", doc]);
    expect({ code: r.code, disk: readFileSync(doc, "utf8") }).toEqual({ code: 1, disk: THREAD });
    expect(r.out).toContain('a: needs string "match" and "insert"');
  });

  test("a null item is an item error; the good items still land", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-batch-"));
    const doc = join(dir, "b.md");
    writeFileSync(doc, THREAD);
    writeFileSync(join(dir, "e.json"), JSON.stringify([null, { id: "a", match: "hmm", insert: "{>>@claude: ok<<}" }]));
    const r = await cli(["reply", "--batch", join(dir, "e.json"), "--doc", doc]);
    expect({ code: r.code, disk: readFileSync(doc, "utf8") }).toEqual({
      code: 1,
      disk: "Intro {==one==}{>>@luis: hmm<<}{>>@claude: ok<<} tail.\n",
    });
    expect(r.out).toContain('#1: needs string "match" and "insert"');
  });

  test("an all-good batch still exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-batch-"));
    const doc = join(dir, "b.md");
    writeFileSync(doc, THREAD);
    writeFileSync(join(dir, "e.json"), JSON.stringify([{ id: "a", match: "hmm", insert: "{>>@claude: ok<<}" }]));
    expect((await cli(["reply", "--batch", join(dir, "e.json"), "--doc", doc])).code).toBe(0);
  });
});

describe("#105 a group id the SUGGEST grammar can't read back is refused", () => {
  test("addSuggestion refuses an id with a space or ]", async () => {
    expect(() => addSuggestion("Alpha beta gamma.\n", "beta", "claude", "BETA", "mv 1")).toThrow('invalid group id "mv 1"');
    expect(() => addSuggestion("Alpha beta gamma.\n", "beta", "claude", "BETA", "a]b")).toThrow('invalid group id "a]b"');
  });

  test("addSuggestionsAt refuses it too", async () => {
    expect(() => addSuggestionsAt("Alpha beta.\n", [{ from: 6, to: 10, replacement: "BETA" }], "claude", "mv 1")).toThrow(
      'invalid group id "mv 1"',
    );
  });

  test("a valid id still makes a grouped card", async () => {
    const out = addSuggestion("Alpha beta gamma.\n", "beta", "claude", "BETA", "ok");
    expect(suggestCards(out).length).toBe(1);
  });

  test("acm suggest --group with a bad id exits 1 and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-group-"));
    const doc = join(dir, "g.md");
    writeFileSync(doc, "Alpha beta gamma.\n");
    const r = await cli(["suggest", "beta", "BETA", "--group", "mv 1", "--doc", doc]);
    expect({ code: r.code, disk: readFileSync(doc, "utf8") }).toEqual({ code: 1, disk: "Alpha beta gamma.\n" });
  });
});

describe("#106 acm wrap keeps the document's line endings", () => {
  test("an LF document with a CRLF comment stays LF outside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-wrap-"));
    const doc = join(dir, "w.md");
    const seed = "Intro {>>@luis: line one\r\nline two<<} end.\n\nNext para.\n";
    writeFileSync(doc, seed);
    await cli(["wrap", "88", "--doc", doc]);
    expect(readFileSync(doc, "utf8")).toBe(seed);
  });

  test("a mixed document keeps the LF inside a multi-line comment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-wrap-"));
    const doc = join(dir, "w.md");
    const seed = "Intro {>>@luis: line one\nline two<<} end.\r\n";
    writeFileSync(doc, seed);
    await cli(["wrap", "88", "--doc", doc]);
    expect(readFileSync(doc, "utf8")).toBe(seed);
  });

  test("a CRLF document stays all-CRLF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-clifix-wrap-"));
    const doc = join(dir, "w.md");
    writeFileSync(doc, "Intro line.\r\n\r\nThe quick brown fox jumps over the lazy dog again and again and again forever.\r\n");
    expect((await cli(["wrap", "40", "--doc", doc])).code).toBe(0);
    expect(readFileSync(doc, "utf8")).toBe(
      "Intro line.\r\n\r\nThe quick brown fox jumps over the lazy\r\ndog again and again and again forever.\r\n",
    );
  });
});

describe("#117 acm <verb> --help", () => {
  test("prints the verb's usage and exits 0, with no document needed", async () => {
    const r = await cli(["threads", "--help"], { ACM_DOC: "" });
    expect(r.code).toBe(0);
    expect(r.out.split("\n").slice(0, 2)).toEqual([
      "Usage:",
      "  acm threads [--json]              List threads: anchor, authors, count, [SUGGEST]",
    ]);
  });
});
