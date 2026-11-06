import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";

const binary = resolve(import.meta.dir, `../dist/${process.platform === "win32" ? "acm.exe" : "acm"}`);
const dir = realpathSync(mkdtempSync(join(tmpdir(), "acm-bin-smoke-")));
const isolatedEnv = { ...process.env, XDG_CONFIG_HOME: join(dir, ".config") };

interface PipedProcess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
}

async function waitForUrl(
  proc: PipedProcess,
  pattern: RegExp,
  label: string,
): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(1, remaining)).then(() => ({ done: true, value: undefined })),
    ]);
    if (next.value) output += decoder.decode(next.value, { stream: true });
    const match = output.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
    if (next.done) break;
  }
  throw new Error(`${label} did not report a URL:\n${output}`);
}

async function stop(proc: PipedProcess) {
  proc.kill();
  await proc.exited;
}

try {
  const source = join(dir, "google-export.docx");
  const output = join(dir, "google-export.md");
  const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const documentXml = `<?xml version="1.0"?>
    <w:document xmlns:w="${wordNamespace}"><w:body><w:p>
      <w:commentRangeStart w:id="1"/><w:r><w:t>Standalone import.</w:t></w:r><w:commentRangeEnd w:id="1"/>
    </w:p></w:body></w:document>`;
  const commentsXml = `<?xml version="1.0"?>
    <w:comments xmlns:w="${wordNamespace}"><w:comment w:id="1" w:author="QA">
      <w:p><w:r><w:t>Embedded comment.</w:t></w:r></w:p>
    </w:comment></w:comments>`;
  writeFileSync(
    source,
    zipSync({
      "word/document.xml": strToU8(documentXml),
      "word/comments.xml": strToU8(commentsXml),
    }),
  );

  const imported = Bun.spawnSync([binary, "import", source, output], {
    cwd: dir,
    env: isolatedEnv,
  });
  if (imported.exitCode !== 0) {
    throw new Error(`compiled import failed:\n${imported.stderr.toString()}`);
  }
  const expected = "{==Standalone import.==}{>>@QA: Embedded comment.<<}\n";
  if (readFileSync(output, "utf8") !== expected) {
    throw new Error("compiled import output did not preserve the anchored comment");
  }

  // The embedded Hunspell dicts must load inside the binary (no node_modules here):
  // `acm spell suggest` turns a typo into an anchored SUGGEST card.
  const spellDoc = join(dir, "spell.md");
  writeFileSync(spellDoc, "We recieve it.\n");
  const spelled = Bun.spawnSync([binary, "spell", "suggest", "--doc", spellDoc, "--author", "claude"], {
    cwd: dir,
    env: isolatedEnv,
  });
  const spellExpected = "We {==recieve==}{>>@claude: SUGGEST[g:spelling]: receive<<} it.\n";
  if (spelled.exitCode !== 0 || readFileSync(spellDoc, "utf8") !== spellExpected) {
    throw new Error(`compiled spell suggest failed:\n${spelled.stderr.toString()}`);
  }

  const overview = Bun.spawnSync([binary], { cwd: dir, env: isolatedEnv });
  if (overview.exitCode !== 0 || !overview.stdout.toString().includes("acm edit")) {
    throw new Error("bare compiled CLI did not print its command overview");
  }
  if (existsSync(join(dir, "untitled.md"))) {
    throw new Error("bare compiled CLI created an unnamed document");
  }

  const barePath = Bun.spawnSync([binary, "bare.md", "--no-open"], { cwd: dir, env: isolatedEnv });
  if (barePath.exitCode !== 2 || !barePath.stderr.toString().includes("acm edit bare.md")) {
    throw new Error("compiled CLI accepted a bare filename compatibility alias");
  }
  if (existsSync(join(dir, "bare.md"))) {
    throw new Error("rejected bare filename still created a document");
  }

  const help = Bun.spawnSync([binary, "--help"], { cwd: dir, env: isolatedEnv });
  const helpText = help.stdout.toString();
  if (
    help.exitCode !== 0 ||
    !helpText.includes("Google Docs URL|file.docx") ||
    !helpText.includes("acm edit <file.md>")
  ) {
    throw new Error("compiled CLI help is missing the importer or explicit edit command");
  }

  const documentPath = join(dir, "explicit.md");
  const direct = Bun.spawn([binary, "edit", documentPath, "--no-open", "--port", "0"], {
    cwd: dir,
    env: isolatedEnv,
    stdout: "pipe",
    stderr: "pipe",
  }) as PipedProcess;
  try {
    const url = await waitForUrl(direct, /ACM ready → (http:\/\/localhost:\d+)/, "direct editor");
    const session = await (await fetch(`${url}/api/session`)).json();
    if (JSON.stringify(session) !== JSON.stringify({ mode: "document", path: documentPath })) {
      throw new Error(`compiled direct editor returned the wrong session: ${JSON.stringify(session)}`);
    }
  } finally {
    await stop(direct);
  }

  const launcher = Bun.spawn([binary, "edit", "--no-open", "--port", "0"], {
    cwd: dir,
    env: isolatedEnv,
    stdout: "pipe",
    stderr: "pipe",
  }) as PipedProcess;
  try {
    const launcherUrl = await waitForUrl(
      launcher,
      /ACM launcher → (http:\/\/localhost:\d+)/,
      "document launcher",
    );
    const coldSession = (await (await fetch(`${launcherUrl}/api/session`)).json()) as {
      mode?: string;
      cwd?: string;
      recent?: Array<{ path?: string }>;
    };
    if (
      coldSession.mode !== "launcher" ||
      coldSession.cwd !== dir ||
      coldSession.recent?.[0]?.path !== documentPath
    ) {
      throw new Error(`compiled launcher returned the wrong cold session: ${JSON.stringify(coldSession)}`);
    }
    const opened = await fetch(`${launcherUrl}/api/launcher/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: documentPath, create: false }),
    });
    const openedBody = (await opened.json()) as { url?: string };
    if (!opened.ok || !openedBody.url) {
      throw new Error(`compiled launcher could not hand off its recent document: ${JSON.stringify(openedBody)}`);
    }
    const documentSession = await (await fetch(`${openedBody.url}/api/session`)).json();
    if (JSON.stringify(documentSession) !== JSON.stringify({ mode: "document", path: documentPath })) {
      throw new Error(`compiled launcher handed off the wrong document: ${JSON.stringify(documentSession)}`);
    }
  } finally {
    await stop(launcher);
  }

  console.log(
    "compiled binary smoke: overview + no alias + import + spell suggest + direct edit + launcher handoff passed outside node_modules",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
