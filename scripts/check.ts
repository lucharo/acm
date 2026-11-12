#!/usr/bin/env bun

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

function run(command: string[], env: Record<string, string | undefined> = process.env) {
  const result = Bun.spawnSync(command, { cwd: ROOT, env, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

run(["bun", "run", "typecheck"]);
run(["bun", "run", "test"]);
run(["bun", "run", "build:bin"]);
run(["bun", "run", "test:bin"]);
run(["bun", "run", "test:e2e"]);
run(["bun", "run", "test:install"]);
run(["bun", "run", "test:setup"], {
  ...process.env,
  ACM_PREBUILT_BIN: resolve(ROOT, "dist", process.platform === "win32" ? "acm.exe" : "acm"),
});
