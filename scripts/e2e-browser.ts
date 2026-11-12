// The core review loop in a real headless Chrome, against the compiled binary:
// select a span, open the comment box, Mod-Enter posts, Mod-Shift-Enter posts and
// marks done, Escape cancels, the blue anchor is gone afterwards, the box keys work
// after a click back into the document, and Send and the notify toggle follow
// whether an agent listens. The unit tests check each piece alone; this drives the
// page the way a person does, through Chrome's own input pipeline (CDP Input.*).
//
// Needs Chrome or Chromium: ACM_CHROME, else google-chrome / chromium on PATH, else
// the usual macOS install paths, else a Playwright headless shell. With none found it fails; set ACM_SKIP_BROWSER_SMOKE=1
// to skip it on purpose (it then says so).
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.env.ACM_SKIP_BROWSER_SMOKE === "1") {
  console.log("browser smoke: SKIPPED (ACM_SKIP_BROWSER_SMOKE=1)");
  process.exit(0);
}

const binary = process.env.ACM_E2E_BIN ?? resolve(import.meta.dir, `../dist/${process.platform === "win32" ? "acm.exe" : "acm"}`);
if (!existsSync(binary)) throw new Error(`browser smoke: no binary at ${binary}; run bun run build:bin first`);

function findChrome(): string {
  const fromEnv = process.env.ACM_CHROME?.trim();
  if (fromEnv) return fromEnv;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    const found = Bun.which(name);
    if (found) return found;
  }
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ];
  const hit = mac.find((path) => existsSync(path));
  if (hit) return hit;
  // Playwright's headless shell, if a project on this machine installed one.
  for (const cache of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(cache)) continue;
    for (const entry of readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse()) {
      for (const sub of readdirSync(join(cache, entry))) {
        const shell = join(cache, entry, sub, "chrome-headless-shell");
        if (existsSync(shell)) return shell;
      }
    }
  }
  throw new Error("browser smoke: no Chrome found. Set ACM_CHROME, or ACM_SKIP_BROWSER_SMOKE=1 to skip on purpose.");
}

const started = Date.now();
const dir = realpathSync(mkdtempSync(join(tmpdir(), "acm-e2e-")));
const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"), BROWSER: "/usr/bin/true" };
const doc = join(dir, "review.md");
writeFileSync(
  doc,
  "# Review\n\nFirst paragraph for a plain post.\n\nSecond paragraph to post and mark done.\n\nThird paragraph to cancel on.\n\nFourth paragraph for keys after a click.\n\nFifth paragraph to leave empty.\n",
);

const children: { kill: () => void }[] = [];
const debug = (message: string) => {
  if (process.env.ACM_E2E_DEBUG) console.error(`[e2e ${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
};
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `: ${detail}` : ""}`);
}

async function readUntil(stream: ReadableStream<Uint8Array>, pattern: RegExp, label: string, ms = 15_000) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
      if (!next || next.done) break;
      text += decoder.decode(next.value, { stream: true });
      const match = text.match(pattern);
      if (match) return match;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`${label}: no ${pattern} within ${ms} ms:\n${text}`);
}

// ── A minimal CDP client over Bun's WebSocket ────────────────────────────────
class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      const waiter = msg.id ? this.pending.get(msg.id) : undefined;
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${msg.error.message}`));
      else waiter.resolve(msg.result);
    };
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url);
      ws.onopen = () => ok(new Cdp(ws));
      ws.onerror = () => fail(new Error(`could not open ${url}`));
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() {
    this.ws.close();
  }
}

const MOD = process.platform === "darwin" ? 4 : 2; // Meta on macOS, Ctrl elsewhere
const SHIFT = 8;
const ALT = 1;
const KEYS: Record<string, { code: string; vk: number }> = {
  Enter: { code: "Enter", vk: 13 },
  Escape: { code: "Escape", vk: 27 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  m: { code: "KeyM", vk: 77 },
};

async function main() {
  const editor = Bun.spawn([binary, "edit", doc, "--no-open", "--port", "0"], { cwd: dir, env, stdout: "pipe", stderr: "inherit" });
  children.push(editor);
  const url = (await readUntil(editor.stdout, /ACM ready → (http:\/\/localhost:\d+)/, "editor"))[1]!;
  debug(`editor at ${url}`);

  const profile = join(dir, "chrome");
  const chrome = Bun.spawn(
    [
      findChrome(),
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--no-sandbox",
      "--no-proxy-server",
      "--window-size=1600,1000",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  children.push(chrome);
  // Chrome writes the port it picked to DevToolsActivePort in the profile.
  const portFile = join(profile, "DevToolsActivePort");
  const portDeadline = Date.now() + 30_000;
  while (!existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n")) {
    if (Date.now() > portDeadline) throw new Error("chrome did not start (no DevToolsActivePort within 30 s)");
    await Bun.sleep(100);
  }
  const port = readFileSync(portFile, "utf8").split("\n")[0]!.trim();
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("chrome: no page target");
  const cdp = await Cdp.open(page.webSocketDebuggerUrl);
  debug(`chrome on ${port}`);

  const evaluate = async <T>(expression: string): Promise<T> => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(`evaluate failed: ${expression}\n${JSON.stringify(exceptionDetails)}`);
    return result.value as T;
  };
  const waitFor = async (expression: string, label: string, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(expression)) return true;
      await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const press = async (key: string, modifiers = 0) => {
    const k = KEYS[key]!;
    const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers };
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  const click = async (x: number, y: number) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const centre = (selector: string) =>
    evaluate<[number, number] | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
    );
  const lineStart = (text: string) =>
    evaluate<[number, number]>(
      `(() => { const l = [...document.querySelectorAll(".cm-line")].find((x) => x.textContent.startsWith(${JSON.stringify(text)})); const r = l.getBoundingClientRect(); return [r.x + 2, r.y + r.height / 2]; })()`,
    );
  const state = () =>
    evaluate<{ box: boolean; marks: number; open: string }>(
      `({ box: !!document.querySelector('textarea[aria-label="Comment on selection"]'), marks: document.querySelectorAll(".cm-composer-anchor").length, open: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).find((t) => /\\d+ open|caught up/.test(t)) ?? (document.body.innerText.includes("all caught up") ? "all caught up" : "") })`,
    );
  const fileHas = async (text: string, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (readFileSync(doc, "utf8").includes(text)) return true;
      await Bun.sleep(50);
    }
    return false;
  };
  const openBoxOn = async (paragraph: string) => {
    const [x, y] = await lineStart(paragraph);
    await click(x, y);
    await press("Home");
    await press("End", SHIFT);
    await press("m", MOD | ALT); // Mod-Alt-M: comment on the selection
    await waitFor(`document.activeElement?.getAttribute("aria-label") === "Comment on selection"`, `the comment box on "${paragraph}"`);
  };

  await cdp.send("Page.navigate", { url });
  await waitFor(`!!document.querySelector(".cm-content") && document.querySelector(".cm-content").textContent.includes("Fifth")`, "the editor");

  // 1. Mod-Enter posts; the comment counts as open, the box and its blue anchor go.
  await openBoxOn("First paragraph");
  await cdp.send("Input.insertText", { text: "e2e plain post" });
  await press("Enter", MOD);
  check("Mod-Enter in the box posts the comment", await fileHas("e2e plain post<<}"));
  let s = await state();
  check("after Post the box and its blue anchor are gone", !s.box && s.marks === 0, JSON.stringify(s));
  check("a plain Post leaves the comment open", /1 open/.test(s.open), JSON.stringify(s));

  // 2. Mod-Shift-Enter posts and marks done: nothing left open.
  await openBoxOn("Second paragraph");
  await cdp.send("Input.insertText", { text: "e2e post and done" });
  await press("Enter", MOD | SHIFT);
  check("Mod-Shift-Enter in the box posts the comment", await fileHas("e2e post and done<<}"));
  s = await state();
  check("Post & done marks it done (still 1 open, the first one)", /1 open/.test(s.open) && !s.box && s.marks === 0, JSON.stringify(s));

  // 3. Escape cancels: nothing written, box and anchor gone.
  await openBoxOn("Third paragraph");
  await cdp.send("Input.insertText", { text: "e2e cancelled" });
  await press("Escape");
  await Bun.sleep(300);
  s = await state();
  check("Escape closes the box without posting", !s.box && s.marks === 0 && !readFileSync(doc, "utf8").includes("e2e cancelled"), JSON.stringify(s));

  // 4. After a click back into the document, the box keys still work.
  await openBoxOn("Fourth paragraph");
  await cdp.send("Input.insertText", { text: "e2e keys after click" });
  const [cx, cy] = await lineStart("Fifth paragraph");
  await click(cx + 40, cy);
  await press("Enter", MOD | SHIFT);
  check("Mod-Shift-Enter posts after a click back into the document", await fileHas("e2e keys after click<<}"));
  s = await state();
  check("and the box and its blue anchor are gone", !s.box && s.marks === 0, JSON.stringify(s));

  // 5. An empty box closes on a click back into the document, taking its anchor.
  await openBoxOn("Fifth paragraph");
  const [hx, hy] = await lineStart("First paragraph");
  await click(hx + 40, hy);
  await Bun.sleep(200);
  s = await state();
  check("an empty box and its blue anchor close on a click in the document", !s.box && s.marks === 0, JSON.stringify(s));

  // 6. No agent listening: Send and the notify toggle are greyed out.
  const pill = '[title="Agent: who is listening, and when it is notified"]';
  const sendDisabled = `(() => { const b = [...document.querySelectorAll("button")].find((x) => /^Send \\d+ to agent$/.test(x.textContent.trim())); return b ? b.disabled : null; })()`;
  const toggle = `(() => { const c = document.querySelector('[role="dialog"][aria-label="Agent"] input[type="checkbox"]'); return c ? c.disabled : null; })()`;
  check("no listener: Send is disabled", (await evaluate<boolean | null>(sendDisabled)) === true);
  const [px, py] = (await centre(pill))!;
  await click(px, py);
  await waitFor(`!!document.querySelector('[role="dialog"][aria-label="Agent"]')`, "the agent popover");
  check("no listener: the notify toggle is disabled", (await evaluate<boolean | null>(toggle)) === true);
  check(
    "no listener: the popover shows the listen command for this file",
    await evaluate<boolean>(`document.querySelector('[role="dialog"][aria-label="Agent"]').textContent.includes(${JSON.stringify(`acm edit ${doc} --notify`)})`),
  );
  await press("Escape");
  await click(5, 500); // close the popover (click outside)

  // 7. An agent listening: both come on.
  const listener = Bun.spawn([binary, "edit", doc, "--notify", "--no-open"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  children.push(listener);
  await waitFor(`document.querySelector(${JSON.stringify(pill)})?.textContent.includes("Agent listening")`, "the pill to show a listener", 10_000);
  check("listener: Send is enabled", (await evaluate<boolean | null>(sendDisabled)) === false);
  await click(px, py);
  await waitFor(`!!document.querySelector('[role="dialog"][aria-label="Agent"]')`, "the agent popover");
  check("listener: the notify toggle is enabled", (await evaluate<boolean | null>(toggle)) === false);

  cdp.close();
}

try {
  await main();
} catch (error) {
  failures++;
  console.error(`FAIL ${(error as Error).message}`);
} finally {
  for (const child of children.reverse()) child.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`browser smoke: ${failures === 0 ? "passed" : `${failures} failed`} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(failures === 0 ? 0 : 1);
