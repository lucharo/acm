import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

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
  plugins: [react(), tailwindcss()],
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
