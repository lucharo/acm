import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { directoryDigest } from "./skill-digest";

const ROOT = resolve(import.meta.dir, "..");

test("bun run setup installs a working standalone CLI and managed skill", () => {
  const home = mkdtempSync(join(tmpdir(), "acm-setup-home-"));
  const binDir = join(home, ".local", "bin");
  const binary = join(binDir, process.platform === "win32" ? "acm.exe" : "acm");
  const setupEnv = {
    ...process.env,
    HOME: home,
    ACM_INSTALL_DIR: binDir,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  };

  try {
    if (process.platform !== "win32") {
      const legacyBunBinary = join(home, ".bun", "bin", "acm");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(join(home, ".bun", "bin"), { recursive: true });
      symlinkSync(join(ROOT, "cli.ts"), legacyBunBinary);
      symlinkSync(legacyBunBinary, binary);
    }

    const setup = Bun.spawnSync(["bun", "run", "setup"], {
      cwd: ROOT,
      env: setupEnv,
      timeout: 180_000,
    });

    expect(setup.exitCode, `${setup.stdout}\n${setup.stderr}`).toBe(0);
    expect(existsSync(binary)).toBe(true);
    expect(existsSync(`${binary}.acm-managed`)).toBe(true);
    expect(setup.stdout.toString()).toContain("ACM setup complete");
    expect(setup.stdout.toString()).toContain("Install acm-review with npx skills add");

    const help = Bun.spawnSync([binary, "--help"], { cwd: home, env: { ...process.env, HOME: home } });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("Agent CriticMarkup editor");

    const skill = join(home, ".agents", "skills", "acm-review", "SKILL.md");
    expect(readFileSync(skill, "utf8")).toContain("name: acm-review");
    expect(existsSync(join(home, ".agents", "skills", "acm-review", ".acm-managed"))).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "acm-review", "SKILL.md"))).toBe(true);
    expect(readdirSync(ROOT).filter((name) => name.endsWith(".bun-build"))).toEqual([]);

    const legacySkill = Bun.spawnSync([binary, "skill"], { cwd: home, env: { ...process.env, HOME: home } });
    expect(legacySkill.exitCode).toBe(2);
    expect(legacySkill.stderr.toString()).toContain("install.sh | sh");
    expect(existsSync(join(home, "skill"))).toBe(false);

    const customAuxiliary = join(home, ".agents", "skills", "acm-review", "local-notes.md");
    writeFileSync(customAuxiliary, "locally customized\n");
    const refresh = Bun.spawnSync(["bun", "run", "setup"], {
      cwd: ROOT,
      env: setupEnv,
      timeout: 30_000,
    });
    expect(refresh.exitCode).not.toBe(0);
    expect(refresh.stderr.toString()).toContain("has local changes");
    expect(refresh.stdout.toString()).not.toContain("Install locked dependencies");
    expect(readFileSync(customAuxiliary, "utf8")).toBe("locally customized\n");

    const forcedRefresh = Bun.spawnSync(["bun", "run", "setup", "--force"], {
      cwd: ROOT,
      env: setupEnv,
      timeout: 180_000,
    });
    expect(forcedRefresh.exitCode, `${forcedRefresh.stdout}\n${forcedRefresh.stderr}`).toBe(0);
    const backups = readdirSync(join(home, ".agents", "skill-backups"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, ".agents", "skill-backups", backups[0], "local-notes.md"), "utf8")).toBe(
      "locally customized\n",
    );
    expect(readFileSync(skill, "utf8")).toContain("name: acm-review");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 400_000);

test("setup replaces an untouched skill that came from a release", () => {
  const home = mkdtempSync(join(tmpdir(), "acm-setup-release-skill-"));
  const binDir = join(home, ".local", "bin");
  const skillDir = join(home, ".agents", "skills", "acm-review");

  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "name: acm-review\nolder release\n");
    writeFileSync(join(skillDir, ".acm-managed"), `${directoryDigest(skillDir)}\n`);

    const setup = Bun.spawnSync(["bun", "run", "setup"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        ACM_INSTALL_DIR: binDir,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      },
      timeout: 180_000,
    });

    expect(setup.exitCode, `${setup.stdout}\n${setup.stderr}`).toBe(0);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).not.toContain("older release");
    expect(existsSync(join(home, ".agents", "skill-backups"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 200_000);

test("setup refuses an unrelated acm executable before installing or building", () => {
  const home = mkdtempSync(join(tmpdir(), "acm-setup-conflict-"));
  const binDir = join(home, ".local", "bin");
  const binary = join(binDir, process.platform === "win32" ? "acm.exe" : "acm");
  const executed = join(home, "unknown-acm-was-executed");
  const unrelated = `#!/bin/sh\ntouch '${executed}'\n`;

  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(binary, unrelated);
    chmodSync(binary, 0o755);

    const setup = Bun.spawnSync(["bun", "run", "setup"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        ACM_INSTALL_DIR: binDir,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      },
      timeout: 30_000,
    });

    expect(setup.exitCode).not.toBe(0);
    expect(setup.stderr.toString()).toContain("already exists and is not ACM");
    expect(setup.stdout.toString()).not.toContain("Install locked dependencies");
    expect(readFileSync(binary, "utf8")).toBe(unrelated);
    expect(existsSync(executed)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup rejects a PATH entry that would shadow the installed binary", () => {
  const home = mkdtempSync(join(tmpdir(), "acm-setup-shadow-"));
  const shadowDir = join(home, "shadow", "bin");
  const binDir = join(home, ".local", "bin");
  const shadowBinary = join(shadowDir, process.platform === "win32" ? "acm.exe" : "acm");

  try {
    mkdirSync(shadowDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(shadowBinary, "#!/bin/sh\necho shadowed\n");
    chmodSync(shadowBinary, 0o755);

    const setup = Bun.spawnSync(["bun", "run", "setup"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        ACM_INSTALL_DIR: binDir,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        PATH: `${shadowDir}${process.platform === "win32" ? ";" : ":"}${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      },
      timeout: 30_000,
    });

    expect(setup.exitCode).not.toBe(0);
    expect(setup.stderr.toString()).toContain("would be shadowed");
    expect(setup.stdout.toString()).not.toContain("Install locked dependencies");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

if (process.platform !== "win32") {
  test("setup rejects an old Node version before installing or building", () => {
    const home = mkdtempSync(join(tmpdir(), "acm-setup-old-node-"));
    const toolDir = join(home, "tools");
    const binDir = join(home, ".local", "bin");
    const node = join(toolDir, "node");

    try {
      mkdirSync(toolDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(node, "#!/bin/sh\necho v22.19.0\n");
      chmodSync(node, 0o755);

      const setup = Bun.spawnSync(["bun", "run", "setup"], {
        cwd: ROOT,
        env: {
          ...process.env,
          HOME: home,
          ACM_INSTALL_DIR: binDir,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local", "share"),
          PATH: `${toolDir}:${binDir}:${process.env.PATH ?? ""}`,
        },
        timeout: 30_000,
      });

      expect(setup.exitCode).not.toBe(0);
      expect(setup.stderr.toString()).toContain("requires Node 22.20.0 or newer");
      expect(setup.stdout.toString()).not.toContain("Install locked dependencies");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("setup verifies Claude skill discovery through CLAUDE_CONFIG_DIR", () => {
  const home = mkdtempSync(join(tmpdir(), "acm-setup-claude-config-"));
  const binDir = join(home, ".local", "bin");
  const claudeConfigDir = join(home, "custom-claude");
  const claudeSkill = join(claudeConfigDir, "skills", "acm-review", "SKILL.md");

  try {
    mkdirSync(join(claudeConfigDir, "skills", "acm-review"), { recursive: true });
    writeFileSync(claudeSkill, "stale adapter\n");
    const setup = Bun.spawnSync(["bun", "run", "setup", "--force"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        ACM_INSTALL_DIR: binDir,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      },
      timeout: 180_000,
    });

    expect(setup.exitCode, `${setup.stdout}\n${setup.stderr}`).toBe(0);
    expect(readFileSync(claudeSkill, "utf8")).toContain("name: acm-review");
    expect(readFileSync(claudeSkill, "utf8")).not.toContain("stale adapter");
    const backups = readdirSync(join(home, ".agents", "skill-backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toStartWith("claude-acm-review-");
    expect(readFileSync(join(home, ".agents", "skill-backups", backups[0], "SKILL.md"), "utf8")).toBe(
      "stale adapter\n",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 200_000);
