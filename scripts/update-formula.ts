#!/usr/bin/env bun
// Points Formula/acm.rb at a new release: rewrites the release tag in each
// asset url and the sha256 under it from that release's SHA256SUMS.
//
//   bun run scripts/update-formula.ts <version> <SHA256SUMS> [formula]
//
// The release workflow runs it after publishing, then commits the result.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const FORMULA_ASSETS = ["acm-darwin-arm64", "acm-darwin-x64", "acm-linux-x64"] as const;

export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

export function updateFormula(formula: string, version: string, sums: Map<string, string>): string {
  const bare = version.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(bare)) throw new Error(`not a release version: ${version}`);
  let out = formula;
  for (const asset of FORMULA_ASSETS) {
    const sha = sums.get(asset);
    if (!sha) throw new Error(`SHA256SUMS does not list ${asset}`);
    const pattern = new RegExp(
      `(url "https://github\\.com/lucharo/acm/releases/download/)v[^/"]+(/${asset}"\\n\\s*sha256 ")[0-9a-f]{64}(")`,
    );
    if (!pattern.test(out)) throw new Error(`the formula has no url and sha256 pair for ${asset}`);
    out = out.replace(pattern, `$1v${bare}$2${sha}$3`);
  }
  return out;
}

if (import.meta.main) {
  const [version, sumsPath, formulaArg] = process.argv.slice(2);
  if (!version || !sumsPath) {
    console.error("usage: bun run scripts/update-formula.ts <version> <SHA256SUMS> [formula]");
    process.exit(2);
  }
  const formulaPath = resolve(formulaArg ?? resolve(import.meta.dir, "..", "Formula", "acm.rb"));
  const updated = updateFormula(
    readFileSync(formulaPath, "utf8"),
    version,
    parseSums(readFileSync(sumsPath, "utf8")),
  );
  writeFileSync(formulaPath, updated);
  console.log(`${formulaPath} now points at ${version}`);
}
