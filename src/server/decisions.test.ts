import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDecisionEvent, type DecisionEvent } from "../lib/decision";
import {
  appendDecisionEvent,
  appendDecisionEvents,
  decisionLogPath,
  listDecisionEvents,
  readDecisionHistory,
} from "./decisions";

const event: DecisionEvent = {
  id: "decision-001",
  timestamp: "2026-08-04T12:00:00.000Z",
  action: "accept",
  actor: "Luis",
  source: "gui",
  target: { kind: "comment", id: "comment-1", threadId: "thread-1" },
  anchor: "original clause",
  originalText: "original clause",
  proposedText: "replacement clause",
  resultingText: "replacement clause",
};

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("decision event model", () => {
  test("requires the canonical audit fields", () => {
    expect(isDecisionEvent(event)).toBe(true);
    expect(isDecisionEvent({ ...event, actor: 42 })).toBe(false);
    expect(isDecisionEvent({ ...event, actor: "   " })).toBe(false);
    expect(isDecisionEvent({ ...event, target: { kind: "other", id: "x" } })).toBe(false);
  });
});

describe("decision JSONL store", () => {
  test("appends inspectable events once per document and retries idempotently", async () => {
    dir = mkdtempSync(join(tmpdir(), "acm-decisions-"));
    const first = join(dir, "first.md");
    const second = join(dir, "second.md");
    writeFileSync(first, "first\n");
    writeFileSync(second, "second\n");

    expect(await appendDecisionEvent(first, event)).toEqual({ appended: true });
    expect(await appendDecisionEvent(first, event)).toEqual({ appended: false });
    expect(await listDecisionEvents(first)).toEqual([event]);
    expect(await listDecisionEvents(second)).toEqual([]);

    const log = decisionLogPath(first);
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8")).toBe(`${JSON.stringify(event)}\n`);
  });

  test("appends a group decision batch in one complete ordered payload", async () => {
    dir = mkdtempSync(join(tmpdir(), "acm-decisions-batch-"));
    const first = join(dir, "group.md");
    writeFileSync(first, "group\n");
    const second = {
      ...event,
      id: "decision-002",
      target: { kind: "suggestion" as const, id: "suggestion-2", groupId: "group-1" },
    };

    expect(await appendDecisionEvents(first, [event, second])).toEqual({ appended: 2 });
    expect(await appendDecisionEvents(first, [event, second])).toEqual({ appended: 0 });
    expect(await listDecisionEvents(first)).toEqual([event, second]);
  });

  test("concurrent appenders persist one copy of the same decision id", async () => {
    dir = mkdtempSync(join(tmpdir(), "acm-decisions-concurrent-"));
    const doc = join(dir, "shared.md");
    writeFileSync(doc, "shared\n");

    const results = await Promise.all([
      appendDecisionEvents(doc, [event]),
      appendDecisionEvents(doc, [event]),
    ]);

    expect(results.map(({ appended }) => appended).sort()).toEqual([0, 1]);
    expect(await listDecisionEvents(doc)).toEqual([event]);
    expect(readFileSync(decisionLogPath(doc), "utf8")).toBe(`${JSON.stringify(event)}\n`);
  });

  test("reads a legacy blank GUI actor and allows future appends", async () => {
    dir = mkdtempSync(join(tmpdir(), "acm-decisions-legacy-gui-"));
    const doc = join(dir, "legacy.md");
    writeFileSync(doc, "legacy\n");
    const log = decisionLogPath(doc);
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, `${JSON.stringify({ ...event, actor: "   " })}\n`);
    const next = { ...event, id: "decision-002" };

    expect(await listDecisionEvents(doc)).toEqual([{ ...event, actor: "You" }]);
    expect(await appendDecisionEvent(doc, next)).toEqual({ appended: true });
    expect(await listDecisionEvents(doc)).toEqual([{ ...event, actor: "You" }, next]);
  });

  test("reads a legacy blank CLI actor with the CLI fallback identity", async () => {
    dir = mkdtempSync(join(tmpdir(), "acm-decisions-legacy-cli-"));
    const doc = join(dir, "legacy.md");
    writeFileSync(doc, "legacy\n");
    const log = decisionLogPath(doc);
    mkdirSync(dirname(log), { recursive: true });
    const legacy = { ...event, actor: "\t", source: "cli" as const };
    writeFileSync(log, `${JSON.stringify(legacy)}\n`);

    expect(await listDecisionEvents(doc)).toEqual([{ ...legacy, actor: "acm-cli" }]);
  });

  test("a truncated JSON line does not hide valid history or block future appends", async () => {
    dir = mkdtempSync(join(tmpdir(), "acm-decisions-truncated-"));
    const doc = join(dir, "truncated.md");
    writeFileSync(doc, "truncated\n");
    const log = decisionLogPath(doc);
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, `${JSON.stringify(event)}\n{"id":`);
    const next = { ...event, id: "decision-002" };

    expect(await listDecisionEvents(doc)).toEqual([event]);
    expect(await appendDecisionEvent(doc, next)).toEqual({ appended: true });
    expect(await listDecisionEvents(doc)).toEqual([event, next]);
    expect(await readDecisionHistory(doc)).toEqual({
      decisionEvents: [event, next],
      issues: [
        {
          line: 2,
          code: "invalid-json",
          message: "Decision history line 2 contains invalid JSON.",
        },
      ],
    });
    expect(readFileSync(log, "utf8")).toBe(
      `${JSON.stringify(event)}\n{"id":\n${JSON.stringify(next)}\n`,
    );
  });

  test("an invalid event line does not hide later valid events or block deduplication", async () => {
    dir = mkdtempSync(join(tmpdir(), "acm-decisions-invalid-event-"));
    const doc = join(dir, "invalid-event.md");
    writeFileSync(doc, "invalid event\n");
    const log = decisionLogPath(doc);
    mkdirSync(dirname(log), { recursive: true });
    const next = { ...event, id: "decision-002" };
    writeFileSync(log, `${JSON.stringify(event)}\n${JSON.stringify({ id: "broken" })}\n${JSON.stringify(next)}\n`);

    expect(await listDecisionEvents(doc)).toEqual([event, next]);
    expect(await appendDecisionEvents(doc, [event, next])).toEqual({ appended: 0 });
    expect(await readDecisionHistory(doc)).toEqual({
      decisionEvents: [event, next],
      issues: [
        {
          line: 2,
          code: "invalid-event",
          message: "Decision history line 2 is not a valid decision event.",
        },
      ],
    });
  });
});
