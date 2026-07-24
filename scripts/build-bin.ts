#!/usr/bin/env bun
// Bun leaves its previous compiled output behind as a hidden `*.bun-build`
// executable when overwriting dist/acm on some platforms. Compile from a clean
// target and remove only Bun's exact generated-artifact pattern afterwards.

import { readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const output = join(ROOT, "dist", process.platform === "win32" ? "acm.exe" : "acm");
const bunBuildArtifact = /^\.[a-f0-9]+-\d+\.bun-build$/;

function cleanGeneratedArtifacts() {
  for (const name of readdirSync(ROOT)) {
    if (bunBuildArtifact.test(name)) rmSync(join(ROOT, name), { force: true });
  }
}

rmSync(output, { force: true });
cleanGeneratedArtifacts();

const result = Bun.spawnSync(
  ["bun", "build", "--compile", "--outfile", output, join(ROOT, "cli.ts")],
  { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
);

cleanGeneratedArtifacts();
if (result.exitCode !== 0) process.exit(result.exitCode);
