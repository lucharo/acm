// POST /api/comment anchoring (#49): a text `anchor` is a unique prose span the
// comment anchors on (same rule as `acm comment`); a number is a point-comment
// offset. Anything the server can't place exactly is refused, never written at 0.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type AcmServer } from "../../server";

const DOC = "# Title\n\nThe conference hall was beaming full of people. It was loud.\n";
const live: AcmServer[] = [];
let previousConfigHome: string | undefined;

beforeAll(() => {
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "acm-comment-api-xdg-"));
});
afterAll(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});
afterEach(() => {
  while (live.length) live.pop()!.stop();
});

async function post(docPath: string, payload: Record<string, unknown>) {
  const acm = startServer({ docPath, port: 0, staticDir: "./dist" });
  live.push(acm);
  return fetch(`http://127.0.0.1:${acm.server.port}/api/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentPath: docPath, author: "claude", ...payload }),
  });
}

async function freshDoc(content = DOC): Promise<string> {
  const docPath = join(mkdtempSync(join(tmpdir(), "acm-comment-api-")), "doc.md");
  await Bun.write(docPath, content);
  return docPath;
}

describe("POST /api/comment anchor", () => {
  test("a text anchor wraps the unique span and places the comment after it", async () => {
    const docPath = await freshDoc();
    const response = await post(docPath, {
      anchor: "The conference hall was beaming full of people.",
      text: "tighten",
    });
    expect(response.status).toBe(200);
    expect(await Bun.file(docPath).text()).toBe(
      "# Title\n\n{==The conference hall was beaming full of people.==}{>>@claude: tighten<<} It was loud.\n",
    );
  });

  test("a text anchor that occurs twice is refused with 422 and nothing is written", async () => {
    const docPath = await freshDoc("It was loud. It was loud.\n");
    const response = await post(docPath, { anchor: "It was loud.", text: "x" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "anchor-not-unique",
        message: '"It was loud." occurs 2 times as a wrappable span (need exactly 1)',
      },
    });
    expect(await Bun.file(docPath).text()).toBe("It was loud. It was loud.\n");
  });

  test("a text anchor absent from the document is refused with 422", async () => {
    const docPath = await freshDoc();
    const response = await post(docPath, { anchor: "not in the doc", text: "x" });
    expect(response.status).toBe(422);
    expect(await Bun.file(docPath).text()).toBe(DOC);
  });

  test("a numeric anchor still drops a point comment at that offset", async () => {
    const docPath = await freshDoc();
    const response = await post(docPath, { anchor: 9, text: "point" });
    expect(response.status).toBe(200);
    expect(await Bun.file(docPath).text()).toBe(
      "# Title\n\n{>>@claude: point<<}The conference hall was beaming full of people. It was loud.\n",
    );
  });

  test("an anchor that is neither text nor an in-range integer is refused with 400", async () => {
    for (const anchor of [undefined, null, -1, 1.5, DOC.length + 1, { span: "x" }, ""]) {
      const docPath = await freshDoc();
      const response = await post(docPath, { anchor, text: "x" });
      expect({ anchor, status: response.status }).toEqual({ anchor, status: 400 });
      expect(await Bun.file(docPath).text()).toBe(DOC);
    }
  });

  test("an empty or missing text is refused with 400", async () => {
    for (const text of [undefined, "", 7]) {
      const docPath = await freshDoc();
      const response = await post(docPath, { anchor: 0, text });
      expect({ text, status: response.status }).toEqual({ text, status: 400 });
      expect(await Bun.file(docPath).text()).toBe(DOC);
    }
  });
});
