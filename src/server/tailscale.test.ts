import { describe, expect, test } from "bun:test";
import { tailscaleDnsName } from "./tailscale";

const status = (backend: string, dns?: string) => JSON.stringify({ BackendState: backend, Self: { DNSName: dns } });

describe("tailscaleDnsName", () => {
  test("a running Tailscale gives its MagicDNS name without the trailing dot", () => {
    expect(tailscaleDnsName(() => status("Running", "mac.tailnet.ts.net."))).toBe("mac.tailnet.ts.net");
  });

  test("a stopped daemon gives none", () => {
    expect(tailscaleDnsName(() => status("Stopped", "mac.tailnet.ts.net."))).toBeNull();
  });

  test("falls back to the macOS app binary when the CLI is not on PATH", () => {
    const tried: string[] = [];
    const name = tailscaleDnsName((argv) => {
      tried.push(argv[0]);
      return argv[0] === "tailscale" ? null : status("Running", "mac.tailnet.ts.net.");
    });
    expect([name, tried]).toEqual([
      "mac.tailnet.ts.net",
      ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
    ]);
  });

  test("no Tailscale at all, or unreadable output, gives none", () => {
    expect(tailscaleDnsName(() => null)).toBeNull();
    expect(tailscaleDnsName(() => "not json")).toBeNull();
  });
});
