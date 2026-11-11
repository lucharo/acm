// The editor as the agent's listener (#31): wake lines for new comments and the
// end-of-review button, the event stream `acm edit --notify` attaches to, the
// `--wait` read that returns at once when work is already pending, and the
// listening count the page shows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type AcmServer } from "../../server";

/** The header the acm CLI sends; a stream without it is refused. */
const AGENT = { "X-ACM-Agent": "1" };
const DOC = "# Title\n\nThe conference hall was beaming full of people. It was loud.\n";
const live: AcmServer[] = [];
let previousConfigHome: string | undefined;
let configHome: string;

beforeAll(() => {
  previousConfigHome = process.env.XDG_CONFIG_HOME;
});
beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "acm-wake-xdg-"));
  process.env.XDG_CONFIG_HOME = configHome;
});
afterAll(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});
afterEach(() => {
  while (live.length) live.pop()!.stop();
});

function settings(values: Record<string, unknown>) {
  mkdirSync(join(configHome, "acm"), { recursive: true });
  writeFileSync(join(configHome, "acm", "settings.json"), JSON.stringify({ settings: values }));
}

async function boot(onWakeLine?: (line: string) => void, extra: { agentKeepAliveMs?: number } = {}) {
  const docPath = join(mkdtempSync(join(tmpdir(), "acm-wake-")), "doc.md");
  await Bun.write(docPath, DOC);
  const acm = startServer({ docPath, port: 0, staticDir: "./dist", onWakeLine, ...extra });
  live.push(acm);
  const base = `http://127.0.0.1:${acm.server.port}`;
  const comment = (author: string, text: string, anchor = "conference hall") =>
    fetch(`${base}/api/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentPath: docPath, author, text, anchor }),
    });
  const sendReview = (documentPath = docPath) =>
    fetch(`${base}/api/agent/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentPath }),
    });
  const status = async () => (await fetch(`${base}/api/agent`)).json();
  return { acm, base, docPath, comment, sendReview, status };
}

/** Collect lines until `count` arrive; fails after 4 s instead of hanging. */
function collector() {
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  return {
    lines,
    push(line: string) {
      lines.push(line);
      waiters.splice(0).forEach((w) => w());
    },
    async until(count: number) {
      const deadline = Date.now() + 4000;
      while (lines.length < count) {
        if (Date.now() > deadline) throw new Error(`waited for ${count} lines, got ${JSON.stringify(lines)}`);
        await new Promise<void>((done) => {
          waiters.push(done);
          setTimeout(done, 50);
        });
      }
      return lines;
    },
  };
}

async function readLines(res: Response, count: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 4000;
  while (text.split("\n").filter(Boolean).length < count) {
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(0, deadline - Date.now())).then(() => "timeout" as const),
    ]);
    if (chunk === "timeout") throw new Error(`stream gave ${JSON.stringify(text)}`);
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  reader.releaseLock();
  return text.split("\n").filter(Boolean);
}

describe("wake lines from the editor (#31)", () => {
  test("a comment from the person prints a comment line when notify-each is on", async () => {
    settings({ author: "Luis", notifyEachComment: true });
    const out = collector();
    const { comment } = await boot(out.push);

    expect((await comment("Luis", "Too wordy?")).status).toBe(200);

    const [line] = await out.until(1);
    expect(line).toMatch(/^acm: comment #\S+ Luis "conference hall"$/);
  });

  test("with notify-each off a comment is quiet and Send to agent prints one review line", async () => {
    settings({ author: "Luis" });
    const out = collector();
    const { comment, sendReview } = await boot(out.push);
    await comment("Luis", "Too wordy?");
    await comment("Luis", "please suggest an edit", "It was loud");
    await Bun.sleep(1500); // past the detection debounce: only the edit request printed
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/^acm: ask #\S+ Luis "It was loud"$/);

    const res = await sendReview();

    // The edit request went out on its own, so Send hands over only the comment.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listening: 1, sent: { comments: 1, editRequests: 0 } });
    expect(out.lines.at(-1)).toBe("acm: review 1 thread waiting (1 comment, 0 edit requests) - run acm threads");
  });

  test("a comment from the agent itself prints nothing", async () => {
    settings({ author: "Luis", notifyEachComment: true });
    const out = collector();
    const { comment } = await boot(out.push);
    await comment("claude", "A note from the agent");
    await Bun.sleep(1500);
    expect(out.lines).toEqual([]);
  });

  test("Send to agent for another document is refused", async () => {
    settings({ author: "Luis" });
    const { sendReview } = await boot();
    const res = await sendReview("/elsewhere/other.md");
    expect(res.status).toBe(409);
  });
});

describe("the event stream acm edit --notify attaches to", () => {
  test("streams each wake line and counts as a listener while open", async () => {
    settings({ author: "Luis", notifyEachComment: true });
    const { base, comment, status } = await boot();
    expect((await status()).listening).toBe(0);

    const controller = new AbortController();
    const stream = await fetch(`${base}/api/agent/events`, { headers: AGENT, signal: controller.signal });
    expect(stream.status).toBe(200);
    expect((await status()).listening).toBe(1);

    await comment("Luis", "Too wordy?");
    const lines = await readLines(stream, 1);
    expect(lines[0]).toMatch(/^acm: comment #\S+ Luis "conference hall"$/);

    controller.abort();
    const deadline = Date.now() + 2000;
    while ((await status()).listening !== 0 && Date.now() < deadline) await Bun.sleep(50);
    expect((await status()).listening).toBe(0);
  });

  test("opens with the work sent while nobody listened", async () => {
    settings({ author: "Luis" });
    const { base, comment, sendReview } = await boot();
    await comment("Luis", "Too wordy?");
    await sendReview();

    const controller = new AbortController();
    const stream = await fetch(`${base}/api/agent/events`, { headers: AGENT, signal: controller.signal });
    const lines = await readLines(stream, 1);
    controller.abort();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^acm: pending #\S+ Luis "conference hall"$/);
  });

  test("status counts what Send would hand over, and nothing once it is sent", async () => {
    settings({ author: "Luis" });
    const { comment, sendReview, status } = await boot();
    await comment("Luis", "Too wordy?");
    expect(await status()).toEqual({
      listening: 0,
      toSend: { comments: 1, editRequests: 0 },
      notifyEachComment: false,
    });

    await sendReview();

    expect((await status()).toSend).toEqual({ comments: 0, editRequests: 0 });
  });

  test("an Ask agent is sent by itself, so Send does not count it", async () => {
    settings({ author: "Luis" });
    const { comment, status } = await boot(() => {});
    await comment("Luis", "please suggest an edit");
    await Bun.sleep(1200); // past the detection debounce
    expect((await status()).toSend).toEqual({ comments: 0, editRequests: 0 });
  });

  test("the page hears listener and waiting changes over its socket", async () => {
    settings({ author: "Luis" });
    const { base, comment } = await boot();
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const messages: { type: string; listening?: number; toSend?: unknown }[] = [];
    ws.onmessage = (ev) => messages.push(JSON.parse(String(ev.data)));
    await new Promise((done) => (ws.onopen = done));

    await comment("Luis", "Too wordy?");
    const deadline = Date.now() + 4000;
    while (!messages.some((m) => m.type === "agent") && Date.now() < deadline) await Bun.sleep(50);
    ws.close();

    expect(messages.filter((m) => m.type === "agent").at(-1)).toEqual({
      type: "agent",
      listening: 0,
      toSend: { comments: 1, editRequests: 0 },
    });
  });
});

describe("listener hardening (#34 review)", () => {
  test("a stream without the CLI's header is refused, so a cross-site no-cors GET cannot pose as an agent", async () => {
    settings({ author: "Luis" });
    const { base, status } = await boot();
    const res = await fetch(`${base}/api/agent/events`, { headers: {} , signal: AbortSignal.timeout(2000) });
    expect(res.status).toBe(403);
    expect((await status()).listening).toBe(0);
  });

  test("a quiet stream gets a keep-alive line, so the client's read never times out", async () => {
    settings({ author: "Luis" });
    const { base } = await boot(undefined, { agentKeepAliveMs: 100 });
    const controller = new AbortController();
    const res = await fetch(`${base}/api/agent/events`, { headers: AGENT, signal: controller.signal });
    const reader = res.body!.getReader();
    const chunks: string[] = [];
    const deadline = Date.now() + 2000;
    while (chunks.join("").split("\n").length < 4 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    controller.abort();
    expect(chunks.join("")).toBe("\n\n\n");
  });
});

describe("settings changes", () => {
  test("changing the Author setting republishes what Send would hand over (roborev round 6)", async () => {
    settings({ author: "You" });
    const { base, comment } = await boot();
    await comment("Luis", "Too wordy?"); // not the person's yet: Author is You
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const messages: { type: string; toSend?: unknown }[] = [];
    ws.onmessage = (ev) => messages.push(JSON.parse(String(ev.data)));
    await new Promise((done) => (ws.onopen = done));
    await Bun.sleep(900); // past the detection debounce, so only the settings change can push

    await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { author: "Luis" } }),
    });
    const deadline = Date.now() + 3000;
    const latest = () => messages.filter((m) => m.type === "agent").at(-1);
    while (JSON.stringify(latest()?.toSend) !== JSON.stringify({ comments: 1, editRequests: 0 }) && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    ws.close();

    expect(latest()?.toSend).toEqual({ comments: 1, editRequests: 0 });
  });
});

describe("the wait read acm edit --wait makes", () => {
  test("returns at once when sent work is already pending", async () => {
    settings({ author: "Luis" });
    const { base, comment, sendReview } = await boot();
    await comment("Luis", "Too wordy?");
    await sendReview();

    const res = await fetch(`${base}/api/agent/events?wait=1`, { headers: AGENT, signal: AbortSignal.timeout(3000) });

    expect(await res.text()).toMatch(/^acm: pending #\S+ Luis "conference hall"\n$/);
  });

  test("Send counts the wait listener it woke, though the wait then ends", async () => {
    settings({ author: "Luis" });
    const { base, comment, sendReview, status } = await boot();
    await comment("Luis", "Too wordy?");
    const body = fetch(`${base}/api/agent/events?wait=1`, { headers: AGENT, signal: AbortSignal.timeout(4000) }).then((r) => r.text());
    const deadline = Date.now() + 2000;
    while ((await status()).listening !== 1 && Date.now() < deadline) await Bun.sleep(20);

    const res = await sendReview();

    expect(await res.json()).toEqual({ listening: 1, sent: { comments: 1, editRequests: 0 } });
    await body;
  });

  test("otherwise holds until the next wake line, then ends", async () => {
    settings({ author: "Luis" });
    const { base, comment, sendReview } = await boot();
    await comment("Luis", "Too wordy?"); // waiting, but not sent: not pending yet

    const body = fetch(`${base}/api/agent/events?wait=1`, { headers: AGENT, signal: AbortSignal.timeout(4000) }).then((r) => r.text());
    const early = await Promise.race([body.then(() => "ended"), Bun.sleep(400).then(() => "held")]);
    expect(early).toBe("held");

    await sendReview();
    const lines = (await body).split("\n").filter(Boolean); // blank lines are keep-alives
    expect(lines).toEqual(["acm: review 1 thread waiting (1 comment, 0 edit requests) - run acm threads"]);
  });
});
