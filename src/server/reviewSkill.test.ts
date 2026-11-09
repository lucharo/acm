import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startServer, type AcmServer } from "../../server";
import { createUserReviewSkill, findUserReviewSkill, NO_REVIEW_PREFERENCES } from "./reviewSkill";

const live: AcmServer[] = [];
const scratch: string[] = [];
const previous: Record<string, string | undefined> = {};
const ENV_KEYS = ["XDG_CONFIG_HOME", "HOME", "CLAUDE_CONFIG_DIR"];
const SKILL_TEXT = "---\nname: acm-user-preferences\ndescription: mine\n---\n\nNever suggest em dashes.\n";

beforeAll(() => {
  for (const key of ENV_KEYS) previous[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

afterEach(() => {
  while (live.length) live.pop()!.stop();
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function tempHome(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "acm-review-skill-")));
  scratch.push(path);
  process.env.XDG_CONFIG_HOME = join(path, ".config");
  process.env.HOME = path;
  delete process.env.CLAUDE_CONFIG_DIR;
  return path;
}

function writeSkill(root: string): string {
  const path = join(root, "skills", "acm-user-preferences", "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, SKILL_TEXT);
  return path;
}

function serve(root: string, allowedHosts: string[] = []): AcmServer {
  const docPath = join(root, "doc.md");
  writeFileSync(docPath, "A document.\n");
  const acm = startServer({ docPath, port: 0, allowedHosts });
  live.push(acm);
  return acm;
}

async function openSkill(acm: AcmServer, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${acm.port}/api/review-skill/open`, { method: "POST", headers });
}

describe("finding the acm-user-preferences skill", () => {
  test("finds nothing when the user has no preferences, and creates nothing", () => {
    const root = tempHome();

    expect(findUserReviewSkill()).toBeNull();
    expect(existsSync(join(root, ".agents"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  test("finds the skill an agent wrote under .agents", () => {
    const root = tempHome();
    const path = writeSkill(join(root, ".agents"));

    expect(findUserReviewSkill()).toBe(path);
  });

  test("finds the skill an agent wrote under .claude", () => {
    const root = tempHome();
    const path = writeSkill(join(root, ".claude"));

    expect(findUserReviewSkill()).toBe(path);
  });

  test("resolves a symlinked skill to the file it points at", () => {
    const root = tempHome();
    const target = writeSkill(join(root, ".claude"));
    const linked = join(root, ".agents", "skills", "acm-user-preferences", "SKILL.md");
    mkdirSync(dirname(linked), { recursive: true });
    symlinkSync(target, linked);

    expect(findUserReviewSkill()).toBe(target);
  });

  test("follows CLAUDE_CONFIG_DIR", () => {
    const root = tempHome();
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude-elsewhere");
    const path = writeSkill(process.env.CLAUDE_CONFIG_DIR);

    expect(findUserReviewSkill()).toBe(path);
  });
});

describe("creating the skill at the user's request", () => {
  test("writes the suggested structure and links it for Claude Code", () => {
    const root = tempHome();

    const path = createUserReviewSkill();

    expect(path).toBe(join(root, ".agents", "skills", "acm-user-preferences", "SKILL.md"));
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("---\nname: acm-user-preferences\ndescription: ")).toBe(true);
    expect(text).toContain("# Review preferences\n\n## Tone\n");
    expect(lstatSync(join(root, ".claude", "skills", "acm-user-preferences")).isSymbolicLink()).toBe(true);
  });

  test("doesn't fail when the Claude and agents skill folders are the same", () => {
    const root = tempHome();
    process.env.CLAUDE_CONFIG_DIR = join(root, ".agents");

    const path = createUserReviewSkill();

    expect(readFileSync(path, "utf8")).toContain("# Review preferences");
  });

  test("returns an existing skill untouched, wherever it lives", () => {
    const root = tempHome();
    const path = writeSkill(join(root, ".claude"));

    expect(createUserReviewSkill()).toBe(path);
    expect(readFileSync(path, "utf8")).toBe(SKILL_TEXT);
    expect(existsSync(join(root, ".agents"))).toBe(false);
  });
});

describe("what acm-review tells agents", () => {
  const skill = readFileSync(join(import.meta.dir, "../../skills/acm-review/SKILL.md"), "utf8");

  test("names both places the skill can live and its frontmatter", () => {
    expect(skill).toContain("~/.agents/skills/acm-user-preferences/SKILL.md");
    expect(skill).toContain("${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/acm-user-preferences/SKILL.md");
    expect(skill).toContain("Keep one file.");
    expect(skill).toContain("name: acm-user-preferences");
  });

  test("suggests the same structure the Create button writes", () => {
    for (const heading of ["# Review preferences", "## Tone", "## What to flag", "## When to suggest a rewording, and when to comment", "## Words and names to keep as written"]) {
      expect(skill).toContain(`${heading}\n`);
    }
  });

  test("says to create it only from what the user said, or from an interview", () => {
    expect(skill).toContain("Create it only once the user has stated a preference");
    expect(skill).toContain("interview");
  });
});

describe("the review-skill routes", () => {
  test("GET reports whether there is a skill to open", async () => {
    const root = tempHome();
    const acm = serve(root);
    const url = `http://127.0.0.1:${acm.port}/api/review-skill`;

    const before = await (await fetch(url)).json();
    writeSkill(join(root, ".agents"));
    const after = await (await fetch(url)).json();

    expect(before).toEqual({ exists: false });
    expect(after).toEqual({ exists: true });
  });

  test("POST explains what to do when there is no skill, and creates nothing", async () => {
    const root = tempHome();
    const acm = serve(root);

    const response = await openSkill(acm);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: NO_REVIEW_PREFERENCES });
    expect(existsSync(join(root, ".agents"))).toBe(false);
  });

  test("POST with create starts the skill and opens it", async () => {
    const root = tempHome();
    const acm = serve(root);

    const response = await fetch(`http://127.0.0.1:${acm.port}/api/review-skill/open?create=1`, { method: "POST" });
    const body = await response.json();
    const doc = await (await fetch(`${body.url}/api/doc`)).json();

    expect(doc.path).toBe(join(root, ".agents", "skills", "acm-user-preferences", "SKILL.md"));
    expect(doc.content).toContain("# Review preferences");
  });

  test("POST with create is refused through a remote host and creates nothing", async () => {
    const root = tempHome();
    const acm = serve(root, ["mac.tailnet.ts.net"]);

    const response = await fetch(`http://127.0.0.1:${acm.port}/api/review-skill/open?create=1`, {
      method: "POST",
      headers: { host: "mac.tailnet.ts.net" },
    });

    expect(response.status).toBe(409);
    expect(existsSync(join(root, ".agents"))).toBe(false);
  });

  test("POST serves the skill in a second editor and reuses it", async () => {
    const root = tempHome();
    const path = writeSkill(join(root, ".agents"));
    const acm = serve(root);

    const first = await (await openSkill(acm)).json();
    const second = await (await openSkill(acm)).json();
    const doc = await (await fetch(`${first.url}/api/doc`)).json();

    expect(second.url).toBe(first.url);
    expect(doc.path).toBe(path);
    expect(doc.content).toBe(SKILL_TEXT);
  });

  test("POST from the skill's own editor returns that editor", async () => {
    const root = tempHome();
    const acm = startServer({ docPath: writeSkill(join(root, ".agents")), port: 0 });
    live.push(acm);

    const body = await (await openSkill(acm)).json();

    expect(body).toEqual({ url: `http://127.0.0.1:${acm.port}` });
  });

  test("POST leaves the main document as the one the acm verbs pick", async () => {
    const root = tempHome();
    writeSkill(join(root, ".agents"));
    const acm = serve(root);
    await openSkill(acm);
    const registry = join(root, ".config", "acm", "instances.json");
    for (let tries = 0; tries < 50; tries += 1) {
      if (Object.keys(JSON.parse(existsSync(registry) ? readFileSync(registry, "utf8") : "{}")).length === 2) break;
      await Bun.sleep(50);
    }

    // Asynchronous: the CLI probes the servers running in this very process.
    const run = Bun.spawn([process.execPath, join(import.meta.dir, "../../cli.ts"), "threads"], {
      env: { ...process.env, ACM_DOC: "" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);

    expect(exitCode).toBe(0);
    expect(stderr).toContain(`using ${acm.docPath} `);
  }, 20_000);

  test("POST is refused through a remote host, whose tunnel can't reach the second port", async () => {
    const root = tempHome();
    writeSkill(join(root, ".agents"));
    const acm = serve(root, ["mac.tailnet.ts.net"]);

    const response = await openSkill(acm, { host: "mac.tailnet.ts.net" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Run acm skill on the computer running ACM." });
  });
});
