import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const INSTALLER = resolve(import.meta.dir, "..", "install.sh");
const SKILL_TEXT = "name: acm-review\nrelease copy\n";

let root: string;
let home: string;
let release: string;
let stubs: string;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeExecutable(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function publishChecksums() {
  const names = readdirSync(release).filter((name) => name !== "SHA256SUMS");
  const lines = names.map((name) => `${sha256(join(release, name))}  ${name}\n`);
  writeFileSync(join(release, "SHA256SUMS"), lines.join(""));
}

/** uname, and sysctl for the Rosetta check, are the only host facts the installer reads. */
function pretendPlatform(os: string, arch: string, translated = "0") {
  writeExecutable(join(stubs, "uname"), `#!/bin/sh\n[ "$1" = -s ] && echo ${os} || echo ${arch}\n`);
  writeExecutable(join(stubs, "sysctl"), `#!/bin/sh\necho ${translated}\n`);
}

function runInstaller(env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["sh", INSTALLER], {
    cwd: root,
    env: {
      HOME: home,
      PATH: `${stubs}:/usr/bin:/bin`,
      ACM_RELEASE_URL: `file://${release}`,
      ...env,
    },
    timeout: 30_000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function installedBinary() {
  return join(home, ".local", "bin", "acm");
}

function runInstalled(binary = installedBinary()) {
  return Bun.spawnSync([binary, "--help"]).stdout.toString().trim();
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "acm-install-test-")));
  home = join(root, "home");
  release = join(root, "release");
  stubs = join(root, "stubs");
  mkdirSync(home);
  mkdirSync(release);
  mkdirSync(stubs);

  for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
    writeExecutable(join(release, `acm-${platform}`), `#!/bin/sh\necho ${platform}\n`);
  }
  mkdirSync(join(root, "skill", "acm-review"), { recursive: true });
  writeFileSync(join(root, "skill", "acm-review", "SKILL.md"), SKILL_TEXT);
  writeFileSync(join(root, "skill", "acm-review", ".acm-managed"), "release-digest\n");
  Bun.spawnSync(["tar", "-czf", join(release, "acm-review-skill.tar.gz"), "-C", join(root, "skill"), "acm-review"]);
  publishChecksums();
  pretendPlatform("Linux", "x86_64");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a fresh install adds the binary, its marker and the skill for both agents", () => {
  const result = runInstaller();

  expect(result.exitCode, result.stderr).toBe(0);
  expect(runInstalled()).toBe("linux-x64");
  expect(lstatSync(installedBinary()).mode & 0o777).toBe(0o755);
  expect(readFileSync(`${installedBinary()}.acm-managed`, "utf8")).toBe(`${sha256(installedBinary())}\n`);
  expect(readFileSync(join(home, ".agents", "skills", "acm-review", "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
  expect(readFileSync(join(home, ".agents", "skills", "acm-review", ".acm-managed"), "utf8")).toBe("release-digest\n");
  expect(readFileSync(join(home, ".claude", "skills", "acm-review", "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
  expect(lstatSync(join(home, ".claude", "skills", "acm-review")).isSymbolicLink()).toBe(true);
  expect(readdirSync(join(home, ".local", "bin")).sort()).toEqual(["acm", "acm.acm-managed"]);
  expect(result.stdout).toContain("acm edit notes.md");
});

test("an install leaves the user's preferences skill alone", () => {
  const preferences = join(home, ".agents", "skills", "acm-user-preferences", "SKILL.md");
  mkdirSync(join(preferences, ".."), { recursive: true });
  writeFileSync(preferences, "Never suggest em dashes.\n");

  const result = runInstaller();

  expect(result.exitCode, result.stderr).toBe(0);
  expect(readFileSync(preferences, "utf8")).toBe("Never suggest em dashes.\n");
  expect(existsSync(join(home, ".agents", "skill-backups"))).toBe(false);
});

test("the skill follows CLAUDE_CONFIG_DIR", () => {
  const configDir = join(home, "claude-config");

  const result = runInstaller({ CLAUDE_CONFIG_DIR: configDir });

  expect(result.exitCode, result.stderr).toBe(0);
  expect(readFileSync(join(configDir, "skills", "acm-review", "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
  expect(existsSync(join(home, ".claude"))).toBe(false);
});

test("ACM_INSTALL_DIR chooses where the binary goes", () => {
  const custom = join(home, "bin");

  const result = runInstaller({ ACM_INSTALL_DIR: custom });

  expect(result.exitCode, result.stderr).toBe(0);
  expect(runInstalled(join(custom, "acm"))).toBe("linux-x64");
  expect(existsSync(installedBinary())).toBe(false);
});

test.each([
  ["Darwin", "arm64", "0", "darwin-arm64"],
  ["Darwin", "x86_64", "0", "darwin-x64"],
  ["Darwin", "x86_64", "1", "darwin-arm64"],
  ["Linux", "x86_64", "0", "linux-x64"],
])("%s %s (translated=%s) installs %s", (os, arch, translated, expected) => {
  pretendPlatform(os, arch, translated);

  const result = runInstaller();

  expect(result.exitCode, result.stderr).toBe(0);
  expect(runInstalled()).toBe(expected);
});

test.each([
  ["Linux", "aarch64", "no ACM build for Linux on aarch64"],
  ["Darwin", "ppc", "no ACM build for macOS on ppc"],
  ["FreeBSD", "amd64", "no ACM build for FreeBSD"],
])("%s %s is refused", (os, arch, message) => {
  pretendPlatform(os, arch);

  const result = runInstaller();

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(message);
  expect(existsSync(installedBinary())).toBe(false);
});

test("a tampered binary is refused and nothing is installed", () => {
  writeExecutable(join(release, "acm-linux-x64"), "#!/bin/sh\necho tampered\n");

  const result = runInstaller();

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("checksum mismatch for acm-linux-x64");
  expect(existsSync(join(home, ".local"))).toBe(false);
  expect(existsSync(join(home, ".agents"))).toBe(false);
});

test("a tampered skill archive is refused and nothing is installed", () => {
  writeFileSync(join(release, "acm-review-skill.tar.gz"), "tampered");

  const result = runInstaller();

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("checksum mismatch for acm-review-skill.tar.gz");
  expect(existsSync(join(home, ".local"))).toBe(false);
});

test("a release that does not list the asset is refused", () => {
  writeFileSync(join(release, "SHA256SUMS"), "");

  const result = runInstaller();

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("SHA256SUMS does not list acm-linux-x64");
});

test("a missing release names the URL it tried", () => {
  const result = runInstaller({ ACM_RELEASE_URL: `file://${join(root, "nowhere")}` });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("could not download");
  expect(result.stderr).toContain("nowhere/SHA256SUMS");
});

test("a binary that does not run never replaces the working one", () => {
  expect(runInstaller().exitCode).toBe(0);
  writeExecutable(join(release, "acm-linux-x64"), "#!/bin/sh\nexit 3\n");
  publishChecksums();

  const result = runInstaller();

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("does not run on this machine");
  expect(runInstalled()).toBe("linux-x64");
  expect(readdirSync(join(home, ".local", "bin")).sort()).toEqual(["acm", "acm.acm-managed"]);
});

test("a program that is not ACM is left alone without ACM_FORCE", () => {
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeExecutable(installedBinary(), "#!/bin/sh\necho someone-elses\n");

  const result = runInstaller();

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("already exists and is not ACM");
  expect(runInstalled()).toBe("someone-elses");
});

test("ACM_FORCE=1 replaces a program that is not ACM", () => {
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeExecutable(installedBinary(), "#!/bin/sh\necho someone-elses\n");

  const result = runInstaller({ ACM_FORCE: "1" });

  expect(result.exitCode, result.stderr).toBe(0);
  expect(runInstalled()).toBe("linux-x64");
});

test("rerunning updates a binary ACM installed", () => {
  expect(runInstaller().exitCode).toBe(0);
  writeExecutable(join(release, "acm-linux-x64"), "#!/bin/sh\necho newer\n");
  publishChecksums();

  const result = runInstaller();

  expect(result.exitCode, result.stderr).toBe(0);
  expect(runInstalled()).toBe("newer");
  expect(readFileSync(`${installedBinary()}.acm-managed`, "utf8")).toBe(`${sha256(installedBinary())}\n`);
});

test("rerunning with an unchanged skill makes no backup", () => {
  expect(runInstaller().exitCode).toBe(0);

  const result = runInstaller();

  expect(result.exitCode, result.stderr).toBe(0);
  expect(existsSync(join(home, ".agents", "skill-backups"))).toBe(false);
});

test("an edited skill is backed up once and replaced for both agents", () => {
  expect(runInstaller().exitCode).toBe(0);
  const skill = join(home, ".agents", "skills", "acm-review", "SKILL.md");
  writeFileSync(skill, "my edits\n");

  const result = runInstaller();

  expect(result.exitCode, result.stderr).toBe(0);
  expect(readFileSync(skill, "utf8")).toBe(SKILL_TEXT);
  expect(readFileSync(join(home, ".claude", "skills", "acm-review", "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
  const backups = readdirSync(join(home, ".agents", "skill-backups"));
  expect(backups.length).toBe(1);
  expect(readFileSync(join(home, ".agents", "skill-backups", backups[0], "SKILL.md"), "utf8")).toBe("my edits\n");
  expect(result.stdout).toContain(`Moved your previous acm-review skill to ${join(home, ".agents", "skill-backups", backups[0])}`);
});

test("a skill that cannot be moved aside stops the install", () => {
  expect(runInstaller().exitCode).toBe(0);
  const skill = join(home, ".agents", "skills", "acm-review", "SKILL.md");
  writeFileSync(skill, "my edits\n");
  const backups = join(home, ".agents", "skill-backups");
  mkdirSync(backups);
  chmodSync(backups, 0o555);

  const result = runInstaller();

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("could not move");
  expect(readFileSync(skill, "utf8")).toBe("my edits\n");
  expect(existsSync(join(home, ".agents", "skills", "acm-review", "acm-review"))).toBe(false);
});

test("a separate Claude Code copy that differs is backed up and linked to the shared skill", () => {
  const claudeSkill = join(home, ".claude", "skills", "acm-review");
  mkdirSync(claudeSkill, { recursive: true });
  writeFileSync(join(claudeSkill, "SKILL.md"), "old copy\n");

  const result = runInstaller();

  expect(result.exitCode, result.stderr).toBe(0);
  expect(lstatSync(claudeSkill).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(claudeSkill, "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
  const backups = readdirSync(join(home, ".agents", "skill-backups"));
  expect(backups.map((name) => name.split("-").slice(0, 3).join("-"))).toEqual(["claude-acm-review"]);
});

test("the PATH hint appears only when the install directory is off PATH", () => {
  const offPath = runInstaller();
  const binDir = join(home, ".local", "bin");
  const onPath = runInstaller({ PATH: `${binDir}:${stubs}:/usr/bin:/bin` });

  expect(offPath.stdout).toContain(`export PATH="${binDir}:$PATH"`);
  expect(onPath.exitCode, onPath.stderr).toBe(0);
  expect(onPath.stdout).not.toContain("export PATH");
  expect(onPath.stdout).not.toContain("Warning");
});

test("a trailing slash on ACM_INSTALL_DIR still matches PATH", () => {
  const custom = join(home, "bin");

  const result = runInstaller({ ACM_INSTALL_DIR: `${custom}/`, PATH: `${custom}:${stubs}:/usr/bin:/bin` });

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).not.toContain("export PATH");
  expect(result.stdout).toContain(`ACM installed: ${join(custom, "acm")}`);
});

test("another acm earlier on PATH is called out", () => {
  const earlier = join(root, "earlier");
  mkdirSync(earlier);
  writeExecutable(join(earlier, "acm"), "#!/bin/sh\necho old\n");
  const binDir = join(home, ".local", "bin");

  const result = runInstaller({ PATH: `${earlier}:${binDir}:${stubs}:/usr/bin:/bin` });

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain(`Warning: acm currently runs ${join(earlier, "acm")}`);
});
