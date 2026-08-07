import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DecisionEvent } from "../lib/decision";
import {
  decisionRecoveryPath,
  readDecisionRecoveryEvents,
  storeDecisionRecoveryEvents,
} from "./decisionRecovery";

const previousXdg = process.env.XDG_CONFIG_HOME;
const scratch: string[] = [];

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function tempConfigHome(): string {
  const root = mkdtempSync(join(tmpdir(), "acm-decision-recovery-lock-"));
  scratch.push(root);
  process.env.XDG_CONFIG_HOME = root;
  return root;
}

function decision(id: string): DecisionEvent {
  return {
    id,
    timestamp: "2026-08-06T12:00:00.000Z",
    action: "accept",
    actor: "Luis",
    source: "gui",
    target: { kind: "comment", id: `comment-${id}`, threadId: `thread-${id}` },
    anchor: `anchor ${id}`,
    originalText: `original ${id}`,
    proposedText: `proposed ${id}`,
    resultingText: `proposed ${id}`,
  };
}

describe("decision recovery repair", () => {
  test("quarantine and rewrite stay atomic across competing ACM processes", async () => {
    const root = tempConfigHome();
    const docPath = join(root, "document.md");
    const recoveryPath = decisionRecoveryPath(docPath);
    mkdirSync(dirname(recoveryPath), { recursive: true });
    writeFileSync(recoveryPath, "{not-json");

    const firstEvent = decision("first");
    const secondEvent = decision("second");
    const originalRename = fsPromises.rename;
    let quarantineCalls = 0;
    let releaseFirstRename!: () => void;
    const firstMayRename = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    let firstRenameEntered!: () => void;
    const firstRenameStarted = new Promise<void>((resolve) => {
      firstRenameEntered = resolve;
    });
    let secondRenameEntered!: () => void;
    const secondRenameStarted = new Promise<void>((resolve) => {
      secondRenameEntered = resolve;
    });
    const renameSpy = spyOn(fsPromises, "rename").mockImplementation(
      async (from, to) => {
        if (String(to).includes(".quarantine-")) {
          quarantineCalls += 1;
          if (quarantineCalls === 1) {
            firstRenameEntered();
            await firstMayRename;
          } else if (quarantineCalls === 2) {
            secondRenameEntered();
          }
        }
        return originalRename(from, to);
      },
    );

    try {
      const first = storeDecisionRecoveryEvents(docPath, [firstEvent]);
      await firstRenameStarted;
      const second = storeDecisionRecoveryEvents(docPath, [secondEvent]);
      const secondEscapedTheLock = await Promise.race([
        secondRenameStarted.then(() => true),
        Bun.sleep(250).then(() => false),
      ]);
      if (secondEscapedTheLock) await second;
      releaseFirstRename();
      await Promise.all([first, second]);

      expect(secondEscapedTheLock).toBe(false);
      expect(await readDecisionRecoveryEvents(docPath)).toEqual([firstEvent, secondEvent]);
    } finally {
      releaseFirstRename();
      renameSpy.mockRestore();
    }
  });
});
