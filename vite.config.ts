import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Inline the bundled Hunspell dictionaries (the `dictionary-en` US + `dictionary-en-gb`
// UK deps) at BUILD time as virtual modules, so the spellchecker can import the raw
// .aff/.dic without the 540KB / ~50k-line files living in git. Read by filesystem PATH
// from node_modules — the package's single-string `exports` blocks subpath `?raw`
// imports, but a path read sidesteps that. The text is inlined into the (lazy) client
// chunk per variant, so it's still embedded in the build + the compiled binary; the
// deps (pinned in bun.lock) are the single source of truth, restored by `bun install`.
// See editor/spellcheck.ts.
function dictionaryRaw(): Plugin {
  const files: Record<string, { pkg: string; file: string }> = {
    "virtual:dict-en/aff": { pkg: "dictionary-en", file: "index.aff" },
    "virtual:dict-en/dic": { pkg: "dictionary-en", file: "index.dic" },
    "virtual:dict-en-gb/aff": { pkg: "dictionary-en-gb", file: "index.aff" },
    "virtual:dict-en-gb/dic": { pkg: "dictionary-en-gb", file: "index.dic" },
  };
  const dirs: Record<string, string> = {};
  const req = createRequire(import.meta.url);
  return {
    name: "acm:dictionary-raw",
    resolveId(id) {
      return id in files ? "\0" + id : null;
    },
    load(id) {
      const entry = files[id.slice(1)];
      if (!id.startsWith("\0") || !entry) return null;
      dirs[entry.pkg] ??= dirname(req.resolve(entry.pkg));
      const text = readFileSync(join(dirs[entry.pkg], entry.file), "utf8");
      return `export default ${JSON.stringify(text)};`;
    },
  };
}

// The .md document is DATA the app writes to on every save — not a source module.
// If it lives inside the Vite root, chokidar sees each write and FULL-PAGE-RELOADS
// the app (~twice a second while typing — "unusable"). Ignore the doc's directory
// from the dev watcher. HMR for real source modules is unaffected, and live doc
// updates still reach the browser over the Bun WebSocket (/ws), not Vite HMR.
// Ignore the EXACT doc file (not its directory) from the dev watcher, so writing
// the document never triggers a full-page reload — and a root-level ACM_DOC (e.g.
// README.md) can't accidentally ignore the whole project and break HMR. seed/** is
// also ignored (the default doc lives there, and it's a dedicated data dir).
const docFile = resolve(process.cwd(), process.env.ACM_DOC ?? "seed/sample-essay.md");
// API/WS server port — the Bun server dev.ts spawns (both read ACM_PORT). Production
// defaults to 12000; dev.ts assigns a free API port well above the dev range.
const apiPort = Number(process.env.ACM_PORT ?? 12000);
// Vite's own dev port. 12000 is RESERVED for the production instance (the one
// actually editing your doc), so dev.ts assigns a random port in 12000+[1,500) and
// passes it here — throwaway dev servers never collide with prod on 12000.
const devPort = Number(process.env.ACM_DEV_PORT ?? 12173);

export default defineConfig({
  plugins: [react(), tailwindcss(), dictionaryRaw()],
  server: {
    port: devPort,
    proxy: {
      "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true },
      "/ws": { target: `ws://localhost:${apiPort}`, ws: true },
    },
    watch: { ignored: [docFile, "**/seed/**"] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
