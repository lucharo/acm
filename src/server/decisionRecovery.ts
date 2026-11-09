// Server-owned retry evidence for GUI decisions whose Markdown write committed
// before the append-only audit log failed. Unlike browser localStorage, this is
// stable across ports, origins and browser profiles. It is a transient outbox;
// the canonical durable history remains the document's .acm decision JSONL.

import { createHash } from "node:crypto";
import { rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDecisionEvent, type DecisionEvent } from "../lib/decision";
import { realpathOr } from "./asset";
import {
  ConfigIntegrityError,
  configHome,
  readConfigStrict,
  withConfigUpdateLock,
  writeConfig,
} from "./config";

const DECISION_RECOVERY_VERSION = 1;

interface DecisionRecoveryFile {
  version: typeof DECISION_RECOVERY_VERSION;
  documentPath: string;
  decisionEvents: DecisionEvent[];
}

/** The folder's physical path plus the file name: the same identity as the decision
 * log kept beside the document, whichever spelling of the folder opened it. */
function recoveryDocumentPath(docPath: string): string {
  const path = resolve(docPath);
  return join(realpathOr(dirname(path)), basename(path));
}

function recoveryName(docPath: string): string {
  const key = createHash("sha256").update(recoveryDocumentPath(docPath)).digest("hex");
  return join("decision-recovery", `${key}.json`);
}

export function decisionRecoveryPath(docPath: string): string {
  return join(configHome(), recoveryName(docPath));
}

function emptyRecovery(docPath: string): DecisionRecoveryFile {
  return {
    version: DECISION_RECOVERY_VERSION,
    documentPath: recoveryDocumentPath(docPath),
    decisionEvents: [],
  };
}

function parseRecovery(docPath: string, value: unknown): DecisionRecoveryFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<DecisionRecoveryFile>;
  if (
    candidate.version !== DECISION_RECOVERY_VERSION ||
    candidate.documentPath !== recoveryDocumentPath(docPath) ||
    !Array.isArray(candidate.decisionEvents) ||
    !candidate.decisionEvents.every(isDecisionEvent)
  ) {
    return null;
  }
  return candidate as DecisionRecoveryFile;
}

async function updateDecisionRecovery(
  docPath: string,
  update: (current: DecisionRecoveryFile) => DecisionRecoveryFile,
  rewriteAfterQuarantine: boolean,
): Promise<{ state: DecisionRecoveryFile; quarantinedPath?: string }> {
  const name = recoveryName(docPath);
  return withConfigUpdateLock(name, async () => {
    let current: DecisionRecoveryFile;
    let quarantinedPath: string | undefined;
    try {
      current = await readConfigStrict(name, emptyRecovery(docPath), (value) =>
        parseRecovery(docPath, value),
      );
    } catch (error) {
      if (!(error instanceof ConfigIntegrityError)) throw error;
      quarantinedPath = await quarantineDecisionRecovery(docPath);
      current = emptyRecovery(docPath);
      if (!rewriteAfterQuarantine) return { state: current, quarantinedPath };
    }
    const state = update(current);
    await writeConfig(name, state);
    return { state, quarantinedPath };
  });
}

export async function readDecisionRecoveryEvents(docPath: string): Promise<DecisionEvent[]> {
  const state = await readConfigStrict(
    recoveryName(docPath),
    emptyRecovery(docPath),
    (value) => parseRecovery(docPath, value),
  );
  return state.decisionEvents;
}

export async function storeDecisionRecoveryEvents(
  docPath: string,
  events: readonly DecisionEvent[],
): Promise<{ stored: number; quarantinedPath?: string }> {
  if (!events.every(isDecisionEvent)) throw new Error("invalid decision recovery event");
  if (events.length === 0) return { stored: 0 };
  let stored = 0;
  const update = (current: DecisionRecoveryFile) => {
    const known = new Set(current.decisionEvents.map((event) => event.id));
    const decisionEvents = [...current.decisionEvents];
    for (const event of events) {
      if (known.has(event.id)) continue;
      known.add(event.id);
      decisionEvents.push(event);
      stored += 1;
    }
    return { ...current, decisionEvents };
  };
  const { quarantinedPath } = await updateDecisionRecovery(docPath, update, true);
  return { stored, ...(quarantinedPath ? { quarantinedPath } : {}) };
}

export async function clearDecisionRecoveryEvents(
  docPath: string,
  acknowledged: readonly DecisionEvent[],
): Promise<{ removed: number; remaining: number; quarantinedPath?: string }> {
  if (acknowledged.length === 0 || !(await Bun.file(decisionRecoveryPath(docPath)).exists())) {
    return { removed: 0, remaining: 0 };
  }
  const ids = new Set(acknowledged.map((event) => event.id));
  let removed = 0;
  const { state, quarantinedPath } = await updateDecisionRecovery(
    docPath,
    (current) => {
      const decisionEvents = current.decisionEvents.filter((event) => {
        if (!ids.has(event.id)) return true;
        removed += 1;
        return false;
      });
      return { ...current, decisionEvents };
    },
    false,
  );
  return {
    removed,
    remaining: state.decisionEvents.length,
    ...(quarantinedPath ? { quarantinedPath } : {}),
  };
}

async function quarantineDecisionRecovery(docPath: string): Promise<string> {
  const path = decisionRecoveryPath(docPath);
  const quarantinedPath = join(
    dirname(path),
    `${basename(path, ".json")}.quarantine-${Date.now()}-${crypto.randomUUID()}.json`,
  );
  await rename(path, quarantinedPath);
  return quarantinedPath;
}
