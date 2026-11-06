import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type AcmServer } from "../../server";

// GET /api/asset end to end (#64): a parent-relative image under the asset root
// serves; outside it is 403 "Blocked" (not 404); a genuinely absent image is 404.

const live: AcmServer[] = [];
let previousConfigHome: string | undefined;

beforeAll(() => {
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "acm-asset-route-xdg-"));
});

afterAll(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});

afterEach(() => {
  while (live.length) live.pop()!.stop();
});

/** base/{repo/{specs/plan/doc.md, org/docs/run.png}, outside.png} */
function layout(opts: { git: boolean }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "acm-asset-route-")));
  const repo = join(base, "repo");
  mkdirSync(join(repo, "specs", "plan", "assets"), { recursive: true });
  mkdirSync(join(repo, "org", "docs"), { recursive: true });
  if (opts.git) mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, "org", "docs", "run.png"), "parent");
  writeFileSync(join(repo, "specs", "plan", "assets", "a.png"), "sibling");
  writeFileSync(join(base, "outside.png"), "outside");
  const docPath = join(repo, "specs", "plan", "doc.md");
  writeFileSync(docPath, "# Plan\n");
  return { repo, docPath };
}

async function getAsset(acm: AcmServer, rel: string) {
  const res = await fetch(`http://127.0.0.1:${acm.port}/api/asset?path=${encodeURIComponent(rel)}`);
  return { status: res.status, body: await res.text() };
}

describe("GET /api/asset with an asset root", () => {
  test("inside a git repo: parent-relative serves, sibling serves, outside is blocked, absent is missing", async () => {
    const { docPath } = layout({ git: true });
    const acm = startServer({ docPath, port: 0 });
    live.push(acm);

    expect(await getAsset(acm, "../../org/docs/run.png")).toEqual({ status: 200, body: "parent" });
    expect(await getAsset(acm, "assets/a.png")).toEqual({ status: 200, body: "sibling" });
    expect((await getAsset(acm, "../../../outside.png")).status).toBe(403);
    expect((await getAsset(acm, "../../../outside.png")).body).toStartWith("Blocked: outside the asset root");
    expect((await getAsset(acm, "../../org/docs/gone.png")).status).toBe(404);
    expect(await getAsset(acm, "../../.git/config")).toEqual({ status: 403, body: "Blocked: not an image type" });
  });

  test("outside a repo: the doc folder only, unless an explicit root is given", async () => {
    const { repo, docPath } = layout({ git: false });
    const confined = startServer({ docPath, port: 0 });
    live.push(confined);
    expect((await getAsset(confined, "../../org/docs/run.png")).status).toBe(403);

    const rooted = startServer({ docPath, port: 0, assetRoot: repo });
    live.push(rooted);
    expect(await getAsset(rooted, "../../org/docs/run.png")).toEqual({ status: 200, body: "parent" });
    expect((await getAsset(rooted, "../../../outside.png")).status).toBe(403);
  });
});
