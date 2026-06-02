// Dev orchestrator: runs the Bun API/WS server and the Vite dev server together.
// Open http://localhost:12000 (Vite, live source + HMR) — it proxies /api and /ws
// to the Bun server on :12001. NB: hitting :12001 directly serves the prebuilt
// ./dist (stale until `bun run build`); use :12000 for live development.
const procs = [
  Bun.spawn(["bun", "--watch", "server.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  }),
  Bun.spawn(["bunx", "vite"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  }),
];

function shutdown() {
  for (const p of procs) p.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race(procs.map((p) => p.exited));
shutdown();
