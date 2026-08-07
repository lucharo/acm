// Append-only decision history stored beside, never inside, the Markdown file.

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  isDecisionEvent,
  parsePersistedDecisionEvent,
  type DecisionEvent,
} from "../lib/decision";
import { selfIgnoreAcmDir } from "./history";
import { withFileUpdateLock } from "./fileLock";

export function decisionLogPath(docPath: string): string {
  return join(dirname(docPath), ".acm", "decisions", `${basename(docPath)}.jsonl`);
}

export interface DecisionHistoryIssue {
  line: number;
  code: "invalid-json" | "invalid-event";
  message: string;
}

export interface DecisionHistory {
  decisionEvents: DecisionEvent[];
  issues: DecisionHistoryIssue[];
}

interface DecisionLogRead extends DecisionHistory {
  text: string;
}

async function readDecisionLog(docPath: string): Promise<DecisionLogRead> {
  const path = decisionLogPath(docPath);
  if (!existsSync(path)) return { decisionEvents: [], issues: [], text: "" };
  const text = await readFile(path, "utf8");
  const decisionEvents: DecisionEvent[] = [];
  const issues: DecisionHistoryIssue[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      issues.push({
        line: index + 1,
        code: "invalid-json",
        message: `Decision history line ${index + 1} contains invalid JSON.`,
      });
      continue;
    }
    const event = parsePersistedDecisionEvent(value);
    if (!event) {
      issues.push({
        line: index + 1,
        code: "invalid-event",
        message: `Decision history line ${index + 1} is not a valid decision event.`,
      });
      continue;
    }
    decisionEvents.push(event);
  }
  return { decisionEvents, issues, text };
}

export async function readDecisionHistory(docPath: string): Promise<DecisionHistory> {
  const { decisionEvents, issues } = await readDecisionLog(docPath);
  return { decisionEvents, issues };
}

export async function listDecisionEvents(docPath: string): Promise<DecisionEvent[]> {
  return (await readDecisionLog(docPath)).decisionEvents;
}

export async function appendDecisionEvent(
  docPath: string,
  event: DecisionEvent,
): Promise<{ appended: boolean }> {
  const result = await appendDecisionEvents(docPath, [event]);
  return { appended: result.appended === 1 };
}

/** Append a complete decision batch in one filesystem write. Group decisions
 * therefore cannot leave a valid-looking partial audit if a later member fails. */
export async function appendDecisionEvents(
  docPath: string,
  events: readonly DecisionEvent[],
): Promise<{ appended: number }> {
  if (!events.every(isDecisionEvent)) throw new Error("invalid decision event");
  if (events.length === 0) return { appended: 0 };
  return withFileUpdateLock(
    `${decisionLogPath(docPath)}.lock`,
    `decision history for ${docPath}`,
    async () => {
      const existing = await readDecisionLog(docPath);
      const known = new Set(existing.decisionEvents.map((candidate) => candidate.id));
      const pending = events.filter((event) => {
        if (known.has(event.id)) return false;
        known.add(event.id);
        return true;
      });
      if (pending.length === 0) return { appended: 0 };

      const path = decisionLogPath(docPath);
      const acmDir = join(dirname(docPath), ".acm");
      await mkdir(dirname(path), { recursive: true });
      selfIgnoreAcmDir(acmDir);
      const separator = existing.text && !existing.text.endsWith("\n") ? "\n" : "";
      await appendFile(
        path,
        separator + pending.map((event) => `${JSON.stringify(event)}\n`).join(""),
        "utf8",
      );
      return { appended: pending.length };
    },
  );
}
