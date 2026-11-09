#!/usr/bin/env bun
// Canonical ACM setup: verify the toolchain, reproduce dependencies, build one
// standalone binary, install it on PATH, and delegate the bundled skill to the
// standard skills manager.

import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { directoryDigest } from "./skill-digest";

const ROOT = resolve(import.meta.dir, "..");
const HOME = homedir();
const SKILLS_CLI = "skills@1.5.20";
const MINIMUM_NODE = [22, 20, 0] as const;
const force = process.argv.slice(2).includes("--force");
const unexpected = process.argv.slice(2).filter((arg) => arg !== "--force");

if (unexpected.length > 0) {
  console.error("usage: bun run setup [--force]");
  process.exit(1);
}

function run(command: string[], label: string, env: Record<string, string | undefined> = process.env) {
  console.log(`\n→ ${label}`);
  const result = Bun.spawnSync(command, {
    cwd: ROOT,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`${label} failed with exit code ${result.exitCode}`);
}

function normalizedPathEntries(): string[] {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => resolve(entry));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function installDirectory(): string {
  if (process.env.ACM_INSTALL_DIR) return resolve(process.env.ACM_INSTALL_DIR);

  const pathEntries = normalizedPathEntries();
  const preferred = [join(HOME, ".local", "bin"), join(HOME, "bin"), join(HOME, ".bun", "bin")];
  return pathEntries.find((entry) => preferred.some((candidate) => samePath(entry, candidate))) ?? preferred[0];
}

function isExecutable(path: string): boolean {
  try {
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    const stat = lstatSync(path);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function commandNames(commandName: string): string[] {
  if (process.platform !== "win32") return [commandName];
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
  return [commandName, ...extensions.map((extension) => `${commandName}${extension}`)];
}

function commandResolutionAfterInstall(commandName: string, installedBinary: string): string | undefined {
  for (const entry of normalizedPathEntries()) {
    for (const name of commandNames(commandName)) {
      const candidate = join(entry, name);
      if (samePath(candidate, installedBinary) || isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function commandVersion(command: string): string {
  try {
    const result = Bun.spawnSync([command, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    if (result.exitCode === 0) return result.stdout.toString().trim();
  } catch {
    // The actionable error below covers missing and broken executables alike.
  }
  throw new Error(`${command} is required before ACM setup can make changes`);
}

function assertNodeToolchain() {
  const version = commandVersion("node");
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`could not parse Node version: ${version}`);

  const actual = match.slice(1, 4).map(Number);
  let comparison = 0;
  for (let index = 0; index < MINIMUM_NODE.length; index++) {
    if (actual[index] !== MINIMUM_NODE[index]) {
      comparison = actual[index] - MINIMUM_NODE[index];
      break;
    }
  }
  if (comparison < 0) {
    throw new Error(`npx ${SKILLS_CLI} requires Node 22.20.0 or newer; current Node is ${version}`);
  }
  commandVersion("npx");
}

function managedMarker(target: string): string {
  return `${target}.acm-managed`;
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function directoryContainsCanonicalFiles(installedDir: string, bundledDir: string): boolean {
  try {
    for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
      const installed = join(installedDir, entry.name);
      const bundled = join(bundledDir, entry.name);
      const installedStat = lstatSync(installed);
      if (entry.isDirectory()) {
        if (!installedStat.isDirectory() || !directoryContainsCanonicalFiles(installed, bundled)) return false;
      } else if (entry.isSymbolicLink()) {
        if (!installedStat.isSymbolicLink() || readlinkSync(installed) !== readlinkSync(bundled)) return false;
      } else if (!installedStat.isFile() || !readFileSync(installed).equals(readFileSync(bundled))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function skillMarker(skillDir: string): string {
  return join(skillDir, ".acm-managed");
}

function skillCanBeReplaced(skillDir: string, bundledSkillDir: string): boolean {
  if (!existsSync(skillDir)) return true;
  try {
    const installedDigest = directoryDigest(skillDir);
    if (installedDigest === directoryDigest(bundledSkillDir)) return true;
    return (
      existsSync(skillMarker(skillDir)) && readFileSync(skillMarker(skillDir), "utf8").trim() === installedDigest
    );
  } catch {
    return false;
  }
}

function directoriesResolveSame(left: string, right: string): boolean {
  if (!existsSync(left) || !existsSync(right)) return false;
  try {
    return samePath(realpathSync(left), realpathSync(right));
  } catch {
    return false;
  }
}

function backupSkill(skillDir: string, label: string): string {
  const backupRoot = join(HOME, ".agents", "skill-backups");
  const backup = join(backupRoot, `${label}-${Date.now()}-${process.pid}`);
  mkdirSync(backupRoot, { recursive: true });
  cpSync(skillDir, backup, { recursive: true, errorOnExist: true });
  console.log(`\n→ Preserve customized skill at ${backup}`);
  return backup;
}

function skillAdapterMatches(adapterSkill: string, universalSkillDir: string, bundledSkillDir: string): boolean {
  if (!existsSync(adapterSkill)) return false;
  const adapterDir = dirname(adapterSkill);
  try {
    return (
      samePath(realpathSync(adapterDir), realpathSync(universalSkillDir)) ||
      directoryContainsCanonicalFiles(adapterDir, bundledSkillDir)
    );
  } catch {
    return false;
  }
}

function targetCanBeReplaced(target: string): boolean {
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  try {
    if (stat.isSymbolicLink()) {
      return (
        samePath(realpathSync(target), join(ROOT, "cli.ts")) ||
        samePath(realpathSync(target), join(ROOT, "dist", process.platform === "win32" ? "acm.exe" : "acm"))
      );
    }
    return (
      stat.isFile() &&
      existsSync(managedMarker(target)) &&
      readFileSync(managedMarker(target), "utf8").trim() === fileDigest(target)
    );
  } catch {
    return false;
  }
}

function installBinary(source: string, target: string) {
  if (!force && !targetCanBeReplaced(target)) {
    throw new Error(`${target} already exists and is not ACM; rerun with --force to replace it`);
  }

  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  copyFileSync(source, temporary);
  chmodSync(temporary, 0o755);
  try {
    renameSync(temporary, target);
  } catch {
    if (existsSync(target)) unlinkSync(target);
    renameSync(temporary, target);
  }
  writeFileSync(managedMarker(target), `${fileDigest(target)}\n`, { mode: 0o600 });
}

const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { packageManager?: string };
const requiredBun = packageJson.packageManager?.match(/^bun@(.+)$/)?.[1];
if (!requiredBun) throw new Error("package.json must pin Bun with packageManager: bun@<version>");
if (Bun.version !== requiredBun) {
  throw new Error(`ACM requires Bun ${requiredBun}; current Bun is ${Bun.version}`);
}
assertNodeToolchain();

const binDir = installDirectory();
const binaryName = process.platform === "win32" ? "acm.exe" : "acm";
const prebuiltBinary = process.env.ACM_PREBUILT_BIN ? resolve(process.env.ACM_PREBUILT_BIN) : undefined;
const builtBinary = prebuiltBinary ?? join(ROOT, "dist", binaryName);
const installedBinary = join(binDir, binaryName);
const bundledSkillDir = join(ROOT, "skills", "acm-review");
const universalSkillDir = join(HOME, ".agents", "skills", "acm-review");
const universalSkill = join(universalSkillDir, "SKILL.md");
const replaceableSkill = skillCanBeReplaced(universalSkillDir, bundledSkillDir);
const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(HOME, ".claude");
const claudeSkillDir = join(claudeConfigDir, "skills", "acm-review");
const claudeSkill = join(claudeSkillDir, "SKILL.md");
const replaceableClaudeSkill =
  !existsSync(claudeSkillDir) ||
  directoriesResolveSame(claudeSkillDir, universalSkillDir) ||
  skillCanBeReplaced(claudeSkillDir, bundledSkillDir);

if (!normalizedPathEntries().some((entry) => samePath(entry, binDir))) {
  throw new Error(`${binDir} is not on PATH; add it to PATH or choose another ACM_INSTALL_DIR`);
}
if (prebuiltBinary && !existsSync(prebuiltBinary)) {
  throw new Error(`ACM_PREBUILT_BIN does not exist: ${prebuiltBinary}`);
}

const resolvedBinary = commandResolutionAfterInstall("acm", installedBinary);
if (!resolvedBinary || !samePath(resolvedBinary, installedBinary)) {
  throw new Error(
    `${installedBinary} would be shadowed by ${resolvedBinary ?? "another PATH entry"}; ` +
      "choose the first suitable PATH directory or remove the conflicting executable",
  );
}

if (!force && !targetCanBeReplaced(installedBinary)) {
  throw new Error(`${installedBinary} already exists and is not ACM; rerun with --force to replace it`);
}
if (!force && !replaceableSkill) {
  throw new Error(`${universalSkillDir} has local changes; rerun with --force to back it up before replacement`);
}
if (!force && !replaceableClaudeSkill) {
  throw new Error(`${claudeSkillDir} has local changes; rerun with --force to back it up before replacement`);
}
if (force && !replaceableSkill && existsSync(universalSkillDir)) backupSkill(universalSkillDir, "acm-review");
if (force && !replaceableClaudeSkill && existsSync(claudeSkillDir)) {
  backupSkill(claudeSkillDir, "claude-acm-review");
}

run(["bun", "install", "--frozen-lockfile"], "Install locked dependencies");
if (prebuiltBinary) console.log(`\n→ Reuse prebuilt ACM binary: ${prebuiltBinary}`);
else run(["bun", "run", "build:bin"], "Build standalone ACM binary");

console.log(`\n→ Install ${installedBinary}`);
installBinary(builtBinary, installedBinary);

run(
  [
    "npx",
    "--yes",
    SKILLS_CLI,
    "add",
    ROOT,
    "--skill",
    "acm-review",
    "--agent",
    "codex",
    "claude-code",
    "--global",
    "--yes",
  ],
  "Install acm-review with npx skills add",
);

if (
  !existsSync(universalSkill) ||
  !directoryContainsCanonicalFiles(universalSkillDir, bundledSkillDir) ||
  !skillAdapterMatches(claudeSkill, universalSkillDir, bundledSkillDir)
) {
  throw new Error("skills CLI completed but acm-review is not discoverable by Codex and Claude Code");
}
writeFileSync(skillMarker(universalSkillDir), `${directoryDigest(universalSkillDir)}\n`, { mode: 0o600 });
if (!directoriesResolveSame(claudeSkillDir, universalSkillDir)) {
  writeFileSync(skillMarker(claudeSkillDir), `${directoryDigest(claudeSkillDir)}\n`, { mode: 0o600 });
}
run([installedBinary, "--help"], "Verify installed CLI");

console.log(`\n✓ ACM setup complete: ${installedBinary}`);
