// The machine's Tailscale MagicDNS name, for the default allowed remote host
// (#73). Best effort and quiet: no Tailscale, a stopped daemon or a slow CLI all
// mean "none" (loopback only), never a startup failure.

const CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

export function tailscaleDnsName(
  run: (argv: string[]) => string | null = (argv) => {
    try {
      const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore", timeout: 1500 });
      return r.exitCode === 0 ? r.stdout.toString() : null;
    } catch {
      return null; // binary not on this machine
    }
  },
): string | null {
  for (const bin of CANDIDATES) {
    const out = run([bin, "status", "--json"]);
    if (out === null) continue;
    try {
      const status = JSON.parse(out) as { BackendState?: string; Self?: { DNSName?: string } };
      const name = status.BackendState === "Running" ? status.Self?.DNSName?.replace(/\.$/, "") : undefined;
      return name || null;
    } catch {
      return null;
    }
  }
  return null;
}
