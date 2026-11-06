// CLI verb dispatch — the reply/apply spellings (the pure edit semantics live in
// lib/agentEdits.test.ts; these pin the dispatch layer: bare reply vs --batch vs
// the deprecated `apply` alias). Spawned as real CLI runs because usage errors
// process.exit; every doc is a temp file passed via --doc, so no editor probing.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  directAuditFailureGuidance,
  isAgentVerb,
  rollBackUnauditedLiveWrite,
  writeDirectWithAudit,
} from "./verbs";
import {
  appendDecisionEvent,
  appendDecisionEvents,
  decisionLogPath,
  listDecisionEvents,
} from "../server/decisions";
import { readDecisionRecoveryEvents } from "../server/decisionRecovery";
import { readDocumentProvenanceRange } from "../server/provenance";
import type { DecisionEvent } from "../lib/decision";
import { commentKey, groupThreads, scanTokens } from "../lib/criticmarkup";
import type { CommentToken } from "../lib/types";

const CLI = resolve(import.meta.dir, "../../cli.ts");
const DOC = 'Prose under review.{>>@luis: is this clear?<<}\n';
const EDITS = [{ id: "t1", match: "is this clear?", insert: "{>>@claude: yes<<}" }];
const DECISION: DecisionEvent = {
  id: "decision-cli-001",
  timestamp: "2026-08-04T12:00:00.000Z",
  action: "resolve",
  actor: "Luis",
  source: "cli",
  target: { kind: "thread", id: "thread-1", threadId: "thread-1" },
  anchor: "Prose under review.",
  originalText: "Prose under review.{>>@luis: is this clear?<<}",
  proposedText: null,
  resultingText: "Prose under review.",
};
const SECOND_DECISION: DecisionEvent = {
  ...DECISION,
  id: "decision-cli-002",
  target: { kind: "thread", id: "thread-2", threadId: "thread-2" },
};

let dir: string;
let doc: string;
let edits: string;
const previousXdg = process.env.XDG_CONFIG_HOME;

function run(...args: string[]) {
  const env = { ...process.env };
  delete env.ACM_AUTHOR; // tests assert the default @claude author
  env.XDG_CONFIG_HOME = join(dir, "config");
  // timeout bounds a dispatch regression: if a verb ever falls out of VERBS,
  // cli.ts treats it as a filename and starts a long-lived server — spawnSync
  // would block forever and wedge the suite instead of failing. Fail fast.
  const p = Bun.spawnSync(["bun", CLI, ...args, "--doc", doc], { cwd: resolve(import.meta.dir, "../.."), env, timeout: 15_000 });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acm-verbs-"));
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  doc = join(dir, "doc.md");
  edits = join(dir, "edits.json");
  writeFileSync(doc, DOC);
  writeFileSync(edits, JSON.stringify(EDITS));
});
afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(dir, { recursive: true, force: true });
});

test("decisions stays on the agent-verb path", () => {
  expect(isAgentVerb("decisions")).toBe(true);
});

test("a compensating live rollback stays bound to the original document", async () => {
  let received: unknown = null;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      received = await request.json();
      return Response.json({ version: 2, content: "before\n" });
    },
  });

  const restored = await rollBackUnauditedLiveWrite(
    server.port!,
    "/docs/original.md",
    "before\n",
    "after\n",
    "after\n",
  );
  server.stop();

  expect(restored).toBe(true);
  expect(received).toEqual({
    base: "after\n",
    content: "before\n",
    documentPath: "/docs/original.md",
    author: "acm-cli",
    operation: "audit rollback",
    decisionEvents: [],
  });
});

test("a compensating rollback preserves a disjoint concurrent human edit", async () => {
  let received: unknown = null;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      received = await request.json();
      return Response.json({ version: 3, content: "old wording\nstable\nhuman after\n" });
    },
  });

  const restored = await rollBackUnauditedLiveWrite(
    server.port!,
    "/docs/original.md",
    "old wording\nstable\nhuman before\n",
    "new wording\nstable\nhuman before\n",
    "new wording\nstable\nhuman after\n",
  );
  server.stop();

  expect(restored).toBe(true);
  expect(received).toEqual({
    base: "new wording\nstable\nhuman after\n",
    content: "old wording\nstable\nhuman after\n",
    documentPath: "/docs/original.md",
    author: "acm-cli",
    operation: "audit rollback",
    decisionEvents: [],
  });
});

test("a compensating direct transaction preserves a disjoint concurrent file edit", async () => {
  const before = "old wording\nstable\nhuman before\n";
  const proposed = "new wording\nstable\nhuman before\n";
  writeFileSync(doc, before);

  const result = await writeDirectWithAudit(
    doc,
    before,
    proposed,
    [DECISION],
    async () => {
      writeFileSync(doc, "new wording\nstable\nhuman after\n");
      throw new Error("audit blocked");
    },
  );

  expect(result).toEqual({
    status: "audit-failed",
    restored: true,
    message: "audit blocked",
  });
  expect(readFileSync(doc, "utf8")).toBe("old wording\nstable\nhuman after\n");
});

test("a direct CLI merge rebases accepted-suggestion audit and provenance ranges", async () => {
  const before = "Header\n{~~old~>new~~}\nnew\n";
  const proposed = "Header\nnew\nnew\n";
  const current = "Agent note\n" + before;
  const final = "Agent note\n" + proposed;
  writeFileSync(doc, current);
  const beforeFrom = before.indexOf("{~~");
  const afterFrom = proposed.indexOf("new");
  const decision: DecisionEvent = {
    id: "direct-merged-suggestion",
    timestamp: "2026-08-14T10:30:00.000Z",
    action: "accept",
    actor: "Luis",
    source: "cli",
    target: {
      kind: "suggestion",
      id: "suggestion-direct-merge",
      beforeFrom,
      beforeTo: beforeFrom + "{~~old~>new~~}".length,
      afterFrom,
      afterTo: afterFrom + 3,
    },
    anchor: "old",
    originalText: "old",
    proposedText: "new",
    resultingText: "new",
    proposer: "Claude",
  };

  const result = await writeDirectWithAudit(
    doc,
    before,
    proposed,
    [decision],
    appendDecisionEvents,
    { author: "Codex", operation: "accept suggestion" },
  );

  expect(result).toEqual({ status: "written", content: final });
  expect(readFileSync(doc, "utf8")).toBe(final);
  const finalFrom = final.indexOf("new");
  expect((await listDecisionEvents(doc))[0].target).toMatchObject({
    afterFrom: finalFrom,
    afterTo: finalFrom + 3,
  });
  expect(await readDocumentProvenanceRange(doc, final, finalFrom, finalFrom + 3)).toMatchObject({
    segments: [{
      from: finalFrom,
      to: finalFrom + 3,
      author: "Claude",
      source: "suggestion",
      reviewedBy: "Luis",
      decisionId: decision.id,
    }],
  });
});

test("a compensating direct transaction refuses an overlapping concurrent file edit", async () => {
  const before = "old wording\nstable\n";
  const proposed = "new wording\nstable\n";
  const concurrent = "new wording revised again\nstable\n";
  writeFileSync(doc, before);

  const result = await writeDirectWithAudit(
    doc,
    before,
    proposed,
    [DECISION],
    async () => {
      writeFileSync(doc, concurrent);
      throw new Error("audit blocked");
    },
  );

  expect(result).toEqual({
    status: "audit-failed",
    restored: false,
    message: "audit blocked",
  });
  expect(readFileSync(doc, "utf8")).toBe(concurrent);
});

test("an uncertain direct audit error does not roll back an event already persisted", async () => {
  const before = "old wording\n";
  const proposed = "new wording\n";
  writeFileSync(doc, before);

  const result = await writeDirectWithAudit(
    doc,
    before,
    proposed,
    [DECISION],
    async (path, events) => {
      await appendDecisionEvents(path, events);
      throw new Error("lock cleanup failed after append");
    },
  );

  expect(result).toEqual({ status: "written", content: proposed });
  expect(readFileSync(doc, "utf8")).toBe(proposed);
  expect(await listDecisionEvents(doc)).toEqual([DECISION]);
});

test("a partial direct audit is retried without reverting its document edit", async () => {
  const before = "old wording\n";
  const proposed = "new wording\n";
  writeFileSync(doc, before);
  let attempts = 0;

  const result = await writeDirectWithAudit(
    doc,
    before,
    proposed,
    [DECISION, SECOND_DECISION],
    async (path, events) => {
      attempts += 1;
      if (attempts === 1) {
        await appendDecisionEvent(path, events[0]);
        throw new Error("audit interrupted after one event");
      }
      return appendDecisionEvents(path, events);
    },
  );

  expect(result).toEqual({ status: "written", content: proposed });
  expect(attempts).toBe(2);
  expect(readFileSync(doc, "utf8")).toBe(proposed);
  expect(await listDecisionEvents(doc)).toEqual([DECISION, SECOND_DECISION]);
});

test("a repeatedly failing partial audit keeps the applied prose instead of creating a ghost event", async () => {
  const before = "old wording\n";
  const proposed = "new wording\n";
  writeFileSync(doc, before);
  let attempts = 0;

  const result = await writeDirectWithAudit(
    doc,
    before,
    proposed,
    [DECISION, SECOND_DECISION],
    async (path, events) => {
      attempts += 1;
      if (attempts === 1) await appendDecisionEvent(path, events[0]);
      throw new Error("audit remains unavailable");
    },
  );

  expect(result).toEqual({
    status: "audit-failed",
    restored: false,
    message: "audit remains unavailable",
    retainedForAuditConsistency: true,
    auditRecovery: {
      status: "stored",
      decisionEventIds: [SECOND_DECISION.id],
    },
  });
  expect(attempts).toBe(2);
  expect(readFileSync(doc, "utf8")).toBe(proposed);
  expect(await listDecisionEvents(doc)).toEqual([DECISION]);
  expect(await readDecisionRecoveryEvents(doc)).toEqual([SECOND_DECISION]);
  if (result.status !== "audit-failed") throw new Error("expected an audit failure");
  expect(directAuditFailureGuidance(result)).toEqual([
    "  document was retained because its decision-history state could not be safely reversed",
    "  missing decision evidence was queued for retry by the next ACM editor; do not restore the backup",
  ]);
});

test("a partial audit reports when its retry evidence cannot be stored", async () => {
  const before = "old wording\n";
  const proposed = "new wording\n";
  writeFileSync(doc, before);
  let attempts = 0;
  const blockedConfig = join(dir, "blocked-config");
  writeFileSync(blockedConfig, "not a directory");
  process.env.XDG_CONFIG_HOME = blockedConfig;

  const result = await writeDirectWithAudit(
    doc,
    before,
    proposed,
    [DECISION, SECOND_DECISION],
    async (path, events) => {
      attempts += 1;
      if (attempts === 1) await appendDecisionEvent(path, events[0]);
      throw new Error("audit remains unavailable");
    },
  );

  expect(result).toEqual({
    status: "audit-failed",
    restored: false,
    message: "audit remains unavailable",
    retainedForAuditConsistency: true,
    auditRecovery: {
      status: "failed",
      decisionEventIds: [SECOND_DECISION.id],
      message: expect.stringContaining("not a directory"),
    },
  });
  expect(readFileSync(doc, "utf8")).toBe(proposed);
  expect(await listDecisionEvents(doc)).toEqual([DECISION]);
  if (result.status !== "audit-failed") throw new Error("expected an audit failure");
  expect(directAuditFailureGuidance(result)).toEqual([
    "  document was retained because its decision-history state could not be safely reversed",
    expect.stringContaining(
      "missing decision evidence could not be queued: ENOTDIR: not a directory",
    ),
  ]);
});

test("direct transactions serialize the document write and audit append", async () => {
  const before = "first old\nstable\nsecond old\n";
  writeFileSync(doc, before);
  let auditEntered!: () => void;
  const auditDidEnter = new Promise<void>((resolve) => {
    auditEntered = resolve;
  });
  let releaseAudit!: () => void;
  const auditMayFinish = new Promise<void>((resolve) => {
    releaseAudit = resolve;
  });

  const first = writeDirectWithAudit(
    doc,
    before,
    "first new\nstable\nsecond old\n",
    [DECISION],
    async () => {
      auditEntered();
      await auditMayFinish;
      return { appended: 1 };
    },
  );
  await auditDidEnter;
  let secondFinished = false;
  const second = writeDirectWithAudit(
    doc,
    before,
    "first old\nstable\nsecond new\n",
    [],
  ).then((result) => {
    secondFinished = true;
    return result;
  });
  await Bun.sleep(20);

  expect(secondFinished).toBe(false);
  releaseAudit();
  expect(await first).toEqual({
    status: "written",
    content: "first new\nstable\nsecond old\n",
  });
  expect(await second).toEqual({
    status: "written",
    content: "first new\nstable\nsecond new\n",
  });
  expect(readFileSync(doc, "utf8")).toBe("first new\nstable\nsecond new\n");
});

test("decisions --json reads the complete persisted event on a cold CLI start", async () => {
  await appendDecisionEvent(doc, DECISION);

  const result = run("decisions", "--json");

  expect(result).toEqual({
    code: 0,
    out: `${JSON.stringify({ decisionEvents: [DECISION] }, null, 2)}\n`,
    err: "",
  });
});

test("decisions --json returns valid events plus complete corruption diagnostics", async () => {
  await appendDecisionEvent(doc, DECISION);
  appendFileSync(decisionLogPath(doc), "{broken\n");

  const result = run("decisions", "--json");

  expect(result).toEqual({
    code: 0,
    out: `${JSON.stringify(
      {
        decisionEvents: [DECISION],
        decisionHistoryIssues: [
          {
            line: 2,
            code: "invalid-json",
            message: "Decision history line 2 contains invalid JSON.",
          },
        ],
      },
      null,
      2,
    )}\n`,
    err: "",
  });
});

test("decisions text output warns about corruption while listing valid events", async () => {
  await appendDecisionEvent(doc, DECISION);
  appendFileSync(decisionLogPath(doc), `${JSON.stringify({ id: "broken" })}\n`);

  const result = run("decisions");

  expect(result.code).toBe(0);
  expect(result.out).toContain(`${DECISION.timestamp}  ${DECISION.actor}  ${DECISION.action}`);
  expect(result.err).toBe(
    "acm decisions: warning: Decision history line 2 is not a valid decision event.\n",
  );
});

test("threads reads the same per-document seen slice as the GUI", () => {
  const content = "{==Same prose==}{>>@maya: Same comment<<}\n";
  const first = doc;
  const second = join(dir, "second.md");
  writeFileSync(first, content);
  writeFileSync(second, content);
  const configDir = join(dir, "config", "acm");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({
      seenByDocument: {
        [resolve(first)]: [commentKey({ author: "maya", body: "Same comment" })],
        [resolve(second)]: [],
      },
    }),
  );

  doc = first;
  const seen = run("threads");
  doc = second;
  const unseen = run("threads");

  expect(seen.code).toBe(0);
  expect(seen.out).toContain("[seen]");
  expect(seen.out).toContain("1 threads, 0 unseen");
  expect(unseen.code).toBe(0);
  expect(unseen.out).not.toContain("[seen]");
  expect(unseen.out).toContain("1 threads, 1 unseen");
}, 15_000);

test("threads marks a thread waiting on a requested edit (#76)", () => {
  writeFileSync(doc, "{==wordy==}{>>@claude: tighten?<<}{>>@You: please suggest an edit<<}\n");

  const result = run("threads");

  expect(result.code).toBe(0);
  expect(result.out).toContain("[edit requested]");
}, 15_000);

test("accept persists a complete CLI decision only after the edit lands", async () => {
  const before = "Before {==old words==}{>>@maya: SUGGEST: new words<<} after.\n";
  writeFileSync(doc, before);
  const comment = scanTokens(before).find(
    (token): token is CommentToken => token.type === "comment",
  )!;
  const [thread] = groupThreads([comment], before);

  const result = run("accept", "new words", "--author", "Reviewer");

  expect(result.code).toBe(0);
  expect(readFileSync(doc, "utf8")).toBe("Before new words after.\n");
  expect(await listDecisionEvents(doc)).toEqual([
    {
      id: expect.any(String),
      timestamp: expect.any(String),
      action: "accept",
      actor: "Reviewer",
      source: "cli",
      target: {
        kind: "suggestion",
        id: comment.id,
        threadId: thread.id,
        beforeFrom: 7,
        beforeTo: 53,
        afterFrom: 7,
        afterTo: 16,
      },
      anchor: "old words",
      originalText: "old words",
      proposedText: "new words",
      resultingText: "new words",
      proposer: "maya",
    },
  ]);
});

test("a direct CLI audit failure restores the document instead of losing its decision", async () => {
  const before = "Before {==old words==}{>>@maya: SUGGEST: new words<<} after.\n";
  writeFileSync(doc, before);
  mkdirSync(join(dir, ".acm"), { recursive: true });
  // A file where the decisions directory must be makes the append fail after
  // the document write, exercising the real direct-CLI boundary.
  writeFileSync(join(dir, ".acm", "decisions"), "blocked");

  const result = run("accept", "new words", "--author", "Reviewer");

  expect(result.code).not.toBe(0);
  expect(readFileSync(doc, "utf8")).toBe(before);
  expect(result.err).toContain("decision history could not be persisted");
  expect(result.err).toContain("document was restored");
});

test("resolve persists the removed thread markup and retained anchor prose", async () => {
  const before = "Before {==wording==}{>>@maya: Discuss this<<} after.\n";
  writeFileSync(doc, before);
  const comment = scanTokens(before).find(
    (token): token is CommentToken => token.type === "comment",
  )!;
  const [thread] = groupThreads([comment], before);

  const result = run("resolve", "Discuss this", "--author", "Reviewer");

  expect(result.code).toBe(0);
  expect(readFileSync(doc, "utf8")).toBe("Before wording after.\n");
  expect(await listDecisionEvents(doc)).toEqual([
    {
      id: expect.any(String),
      timestamp: expect.any(String),
      action: "resolve",
      actor: "Reviewer",
      source: "cli",
      target: {
        kind: "thread",
        id: thread.id,
        threadId: thread.id,
        commentId: comment.id,
      },
      anchor: "wording",
      originalText: "{==wording==}{>>@maya: Discuss this<<}",
      proposedText: null,
      resultingText: "wording",
    },
  ]);
});

test("reject persists the declined proposal and retained original wording", async () => {
  const before = "Before {==old words==}{>>@maya: SUGGEST: new words<<} after.\n";
  writeFileSync(doc, before);
  const comment = scanTokens(before).find(
    (token): token is CommentToken => token.type === "comment",
  )!;
  const [thread] = groupThreads([comment], before);

  const result = run("reject", "new words", "--author", "Reviewer");

  expect(result.code).toBe(0);
  expect(readFileSync(doc, "utf8")).toBe("Before old words after.\n");
  expect(await listDecisionEvents(doc)).toEqual([
    {
      id: expect.any(String),
      timestamp: expect.any(String),
      action: "reject",
      actor: "Reviewer",
      source: "cli",
      target: {
        kind: "suggestion",
        id: comment.id,
        threadId: thread.id,
        beforeFrom: 7,
        beforeTo: 53,
        afterFrom: 7,
        afterTo: 16,
      },
      anchor: "old words",
      originalText: "old words",
      proposedText: "new words",
      resultingText: "old words",
      proposer: "maya",
    },
  ]);
});

test("accepting a suggestion group records every applied member with its group identity", async () => {
  const before =
    "First {==old one==}{>>@maya: SUGGEST[g:pair]: new one<<}.\n\n" +
    "Second {==old two==}{>>@maya: SUGGEST[g:pair]: new two<<}.\n";
  writeFileSync(doc, before);
  const comments = scanTokens(before).filter(
    (token): token is CommentToken => token.type === "comment",
  );
  const threads = groupThreads(comments, before);

  const result = run("accept", "--group", "pair", "--author", "Reviewer");

  expect(result.code).toBe(0);
  expect(readFileSync(doc, "utf8")).toBe("First new one.\n\nSecond new two.\n");
  expect(await listDecisionEvents(doc)).toEqual(
    comments.map((comment, index) => ({
      id: expect.any(String),
      timestamp: expect.any(String),
      action: "accept",
      actor: "Reviewer",
      source: "cli",
      target: {
        kind: "suggestion",
        id: comment.id,
        threadId: threads[index].id,
        groupId: "pair",
        beforeFrom: index === 0 ? 6 : 66,
        beforeTo: index === 0 ? 56 : 116,
        afterFrom: index === 0 ? 6 : 23,
        afterTo: index === 0 ? 13 : 30,
      },
      anchor: index === 0 ? "old one" : "old two",
      originalText: index === 0 ? "old one" : "old two",
      proposedText: index === 0 ? "new one" : "new two",
      resultingText: index === 0 ? "new one" : "new two",
      proposer: "maya",
    })),
  );
});

describe("acm reply dispatch", () => {
  test("bare reply threads a comment onto the matched thread", () => {
    const r = run("reply", "is this clear?", "yes — resolving");
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toContain("<<}{>>@claude: yes — resolving<<}");
    expect(r.out).toContain("acm reply: replied to");
  });

  test("comment --reply threads the same single reply", () => {
    const r = run("comment", "--reply", "is this clear?", "ack");
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toBe(
      "Prose under review.{>>@luis: is this clear?<<}{>>@claude: ack<<}\n",
    );
    // pins the cmd-for-messages contract: the verb reports itself as `comment`,
    // not the internal `op` name it dispatches to.
    expect(r.out).toContain("acm comment: replied to");
  });

  test("comment -r is the short spelling of --reply", () => {
    const r = run("comment", "-r", "is this clear?", "ack");
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toBe(
      "Prose under review.{>>@luis: is this clear?<<}{>>@claude: ack<<}\n",
    );
  });

  test("bare comment anchors a NEW comment on the unique prose span (#42)", () => {
    const r = run("comment", "under review", "which review?");
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toBe(
      "Prose {==under review==}{>>@claude: which review?<<}.{>>@luis: is this clear?<<}\n",
    );
    expect(r.out).toContain('acm comment: comment anchored on "under review" as @claude');
  });

  test("comment --group tags the new comment as a NOTE group member (#77)", () => {
    const r = run("comment", "under review", "which review?", "--group", "pass1");
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toBe(
      "Prose {==under review==}{>>@claude: NOTE[g:pass1]: which review?<<}.{>>@luis: is this clear?<<}\n",
    );
  });

  test("comment --reply refuses --group and writes nothing", () => {
    const r = run("comment", "--reply", "is this clear?", "ack", "--group", "pass1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--group tags a new comment");
    expect(readFileSync(doc, "utf8")).toBe(DOC);
  });

  test("bare comment on a span that is not in the prose fails and writes nothing", () => {
    const r = run("comment", "is this clear?", "ack");
    expect(r.code).toBe(1);
    expect(r.err).toContain('"is this clear?" occurs 0 times as a wrappable span');
    expect(readFileSync(doc, "utf8")).toBe(DOC);
  });

  test("comment --reply with missing args exits non-zero with its own usage", () => {
    const r = run("comment", "--reply", "only-a-phrase");
    expect(r.code).toBe(1);
    expect(r.err).toContain('usage: acm comment --reply "<phrase>" "<text>"');
  });

  test("a pasted blank-line reply survives CLI insertion and a cold file reload", () => {
    const body = "first line\n\nsecond line";

    const result = run("reply", "is this clear?", body);

    expect(result.code).toBe(0);
    const reloaded = readFileSync(doc, "utf8");
    expect(reloaded).toContain("{>>@claude: ~acm1~first line\\n\\nsecond line<<}");
    expect(
      scanTokens(reloaded)
        .filter((token): token is CommentToken => token.type === "comment")
        .map((comment) => comment.body),
    ).toEqual(["is this clear?", body]);
  });

  test("reply --batch applies the edits.json batch", () => {
    const r = run("reply", "--batch", edits);
    expect(r.code).toBe(0);
    expect(r.out).toContain("applied 1/1");
    expect(readFileSync(doc, "utf8")).toContain("{>>@claude: yes<<}");
  });

  test("reply --batch canonicalises a multiline comment before a cold reload", () => {
    writeFileSync(
      edits,
      JSON.stringify([
        {
          id: "multiline",
          match: "is this clear?",
          insert: "{>>@claude: First paragraph.\n\nSecond paragraph.<<}",
        },
      ]),
    );

    const result = run("reply", "--batch", edits);
    const reloaded = readFileSync(doc, "utf8");
    const added = scanTokens(reloaded).find(
      (token): token is CommentToken =>
        token.type === "comment" && token.author === "claude" && token.body.startsWith("First"),
    );

    expect(result.code).toBe(0);
    expect(added?.body).toBe("First paragraph.\n\nSecond paragraph.");
    expect(reloaded).not.toContain("{>>@claude: First paragraph.\n\nSecond paragraph.<<}");
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

describe("acm spell suggest (#29)", () => {
  test("writes one grouped SUGGEST card per flagged occurrence, top suggestion as the fix", () => {
    writeFileSync(doc, "We recieve it. Recieve `recieve` code.\n");
    const r = run("spell", "suggest");
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toBe(
      "We {==recieve==}{>>@claude: SUGGEST[g:spelling]: receive<<} it. " +
        "{==Recieve==}{>>@claude: SUGGEST[g:spelling]: Receive<<} `recieve` code.\n",
    );
    expect(r.out).toContain("acm spell suggest: 2 SUGGEST[g:spelling] cards");
  });

  test("only the named words get cards", () => {
    writeFileSync(doc, "We recieve teh parcel.\n");
    const r = run("spell", "suggest", "teh");
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toBe(
      "We recieve {==teh==}{>>@claude: SUGGEST[g:spelling]: ten<<} parcel.\n",
    );
  });

  test("a re-run adds nothing: words already inside cards are skipped", () => {
    writeFileSync(doc, "We recieve it.\n");
    run("spell", "suggest");
    const once = readFileSync(doc, "utf8");
    const r = run("spell", "suggest");
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toBe(once);
    expect(r.out).toContain("skipped 1 inside existing markup: recieve");
  });

  test("a word with no suggestion is reported, not carded", () => {
    writeFileSync(doc, "The qzxqzxq word.\n");
    const r = run("spell", "suggest");
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toBe("The qzxqzxq word.\n");
    expect(r.out).toContain("no suggestion for: qzxqzxq");
  });

  test("--group names the group", () => {
    writeFileSync(doc, "We recieve it.\n");
    const r = run("spell", "suggest", "--group", "typos");
    expect(r.code).toBe(0);
    expect(readFileSync(doc, "utf8")).toBe(
      "We {==recieve==}{>>@claude: SUGGEST[g:typos]: receive<<} it.\n",
    );
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
