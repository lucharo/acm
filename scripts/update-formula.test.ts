import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSums, updateFormula } from "./update-formula";

const FORMULA = readFileSync(resolve(import.meta.dir, "..", "Formula", "acm.rb"), "utf8");
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const SUMS = `${A}  acm-darwin-arm64\n${B}  acm-darwin-x64\n${C}  acm-linux-x64\n${D}  acm-review-skill.tar.gz\n`;

function pairs(formula: string): string[] {
  return [...formula.matchAll(/url "([^"]+)"\n\s*sha256 "([0-9a-f]{64})"/g)].map((m) => `${m[1]} ${m[2]}`);
}

test("parseSums reads sha256sum output, including binary-mode stars", () => {
  const sums = parseSums(`${A}  acm-darwin-arm64\n${B} *acm-darwin-x64\nnot a checksum line\n`);

  expect([...sums]).toEqual([
    ["acm-darwin-arm64", A],
    ["acm-darwin-x64", B],
  ]);
});

test("updateFormula points every asset of the shipped formula at the new release", () => {
  const updated = updateFormula(FORMULA, "v0.3.1", parseSums(SUMS));

  const base = "https://github.com/lucharo/acm/releases/download/v0.3.1";
  expect(pairs(updated)).toEqual([
    `${base}/acm-darwin-arm64 ${A}`,
    `${base}/acm-darwin-x64 ${B}`,
    `${base}/acm-linux-x64 ${C}`,
  ]);
  const otherLines = (text: string) => text.split("\n").filter((line) => !/url "|sha256 "/.test(line));
  expect(otherLines(updated)).toEqual(otherLines(FORMULA));
});

test("updateFormula refuses a version that is not a plain release", () => {
  expect(() => updateFormula(FORMULA, "v0.3.1-rc.1", parseSums(SUMS))).toThrow("not a release version: v0.3.1-rc.1");
});

test("updateFormula refuses SHA256SUMS that lacks a formula asset", () => {
  const sums = parseSums(`${A}  acm-darwin-arm64\n${B}  acm-darwin-x64\n`);

  expect(() => updateFormula(FORMULA, "0.3.1", sums)).toThrow("SHA256SUMS does not list acm-linux-x64");
});

test("updateFormula refuses a formula missing an asset's url and sha256 pair", () => {
  const formula = FORMULA.replace(/acm-linux-x64/, "acm-linux-arm64");

  expect(() => updateFormula(formula, "0.3.1", parseSums(SUMS))).toThrow(
    "the formula has no url and sha256 pair for acm-linux-x64",
  );
});
