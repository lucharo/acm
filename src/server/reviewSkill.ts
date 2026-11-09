// ── The acm-user-preferences skill ─────────────────────────────────────────────
// Two skills, two owners. acm-review belongs to ACM: an update replaces it and moves
// local edits to a backup. acm-user-preferences belongs to the user: no install or
// update writes it. An agent creates it when the user states a lasting preference or
// asks to be interviewed (acm-review says how), or the user creates it from Settings.

import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SKILL_NAME = "acm-user-preferences";

export const NO_REVIEW_PREFERENCES =
  "No review preferences yet. Tell your agent how you like reviews done, ask it to interview you, or use Create your preferences in Settings.";

/** The structure acm-review suggests to agents, for a skill the user starts by hand. */
const STARTER = `---
name: ${SKILL_NAME}
description: "The user's lasting preferences for reviewing documents in ACM. Load with acm-review before every review."
---

# Review preferences

## Tone

## What to flag

## When to suggest a rewording, and when to comment

## Words and names to keep as written
`;

function skillRoots(): { agents: string; claude: string } {
  const home = process.env.HOME || homedir();
  return { agents: join(home, ".agents"), claude: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude") };
}

function skillFile(root: string): string {
  return join(root, "skills", SKILL_NAME, "SKILL.md");
}

/** The user's skill file, wherever their agent put it, or null if there is none.
 *  Resolved through symlinks, because the editor watches the file's real folder. */
export function findUserReviewSkill(): string | null {
  const { agents, claude } = skillRoots();
  const found = [agents, claude].map(skillFile).find((path) => existsSync(path));
  return found ? realpathSync(found) : null;
}

/** Start the skill at the user's request: one file, linked for Claude Code the way
 *  the installer links acm-review. Never replaces a skill that exists. */
export function createUserReviewSkill(): string {
  const existing = findUserReviewSkill();
  if (existing) return existing;
  const { agents, claude } = skillRoots();
  const path = skillFile(agents);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, STARTER, { flag: "wx" });
  const link = dirname(skillFile(claude));
  mkdirSync(dirname(link), { recursive: true });
  try {
    symlinkSync(dirname(path), link);
  } catch (error) {
    // Already there: the two skill folders are one, or the user has their own.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return path;
}
