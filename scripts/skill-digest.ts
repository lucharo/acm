#!/usr/bin/env bun
// The digest a managed skill's `.acm-managed` marker records. Setup uses it to
// tell an untouched skill from one edited by hand; the release workflow uses it
// so a skill installed from a release counts as untouched too.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export function directoryDigest(directory: string): string {
  const hash = createHash("sha256");

  function visit(current: string, relative: string) {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (relative === "" && entry.name === ".acm-managed") continue;
      const path = join(current, entry.name);
      const child = relative ? join(relative, entry.name) : entry.name;
      hash.update(`${child}\0`);
      if (entry.isDirectory()) {
        hash.update("directory\0");
        visit(path, child);
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${readlinkSync(path)}\0`);
      } else {
        hash.update("file\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  }

  visit(directory, "");
  return hash.digest("hex");
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) {
    console.error("usage: bun run scripts/skill-digest.ts <skill-directory>");
    process.exit(1);
  }
  console.log(directoryDigest(directory));
}
