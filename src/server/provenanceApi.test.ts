import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, type AcmServer } from "../../server";
import type { DecisionEvent } from "../lib/decision";

const live: AcmServer[] = [];
const headers = { "content-type": "application/json" };

afterEach(() => {
  while (live.length) live.pop()!.stop();
});

async function boot(content: string) {
  const docPath = join(mkdtempSync(join(tmpdir(), "acm-provenance-api-")), "draft.md");
  await Bun.write(docPath, content);
  const acm = startServer({ docPath, port: 0, staticDir: "./dist" });
  live.push(acm);
  const url = `http://127.0.0.1:${acm.server.port}`;
  const snapshot = await (await fetch(`${url}/api/doc`)).json() as {
    path: string;
    version: number;
    serverEpoch: string;
  };
  return { url, docPath, snapshot };
}

describe("provenance HTTP protocol", () => {
  test("attributes browser saves to the configured human author", async () => {
    const { url, docPath, snapshot } = await boot("Alpha beta gamma");
    const saved = await fetch(`${url}/api/doc`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        content: "Alpha BETA gamma",
        baseVersion: snapshot.version,
        serverEpoch: snapshot.serverEpoch,
        documentPath: docPath,
        author: "Luis",
      }),
    });
    expect(saved.status).toBe(200);

    const provenance = await fetch(`${url}/api/provenance?from=6&to=10`);
    expect(provenance.status).toBe(200);
    expect(await provenance.json()).toMatchObject({
      contentLength: "Alpha BETA gamma".length,
      segments: [{ from: 6, to: 10, author: "Luis", source: "human", operation: "edit" }],
    });
  });

  test("attributes live CLI writes to their agent author", async () => {
    const { url, docPath } = await boot("Alpha beta");
    const saved = await fetch(`${url}/api/agent-write`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        base: "Alpha beta",
        content: "Alpha BETA",
        documentPath: docPath,
        author: "Codex",
        operation: "suggest",
        decisionEvents: [],
      }),
    });
    expect(saved.status).toBe(200);

    const provenance = await fetch(`${url}/api/provenance?from=6&to=10`);
    expect(await provenance.json()).toMatchObject({
      segments: [{ from: 6, to: 10, author: "Codex", source: "agent", operation: "suggest" }],
    });
  });

  test("attributes a watched filesystem edit to the external writer", async () => {
    const { url, docPath } = await boot("Alpha beta");
    await Bun.write(docPath, "Alpha BETA");
    let observed = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const state = await (await fetch(`${url}/api/doc`)).json() as { content: string };
      if (state.content === "Alpha BETA") {
        observed = true;
        break;
      }
      await Bun.sleep(20);
    }
    expect(observed).toBe(true);

    let provenance: unknown = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      provenance = await (await fetch(`${url}/api/provenance?from=6&to=10`)).json();
      const source = (provenance as { segments?: Array<{ source?: string }> }).segments?.[0]?.source;
      if (source === "external") break;
      await Bun.sleep(20);
    }
    expect(provenance).toMatchObject({
      segments: [{
        from: 6,
        to: 10,
        author: "External edit",
        source: "external",
        operation: "external edit",
      }],
    });
  });

  test("accepted suggestion text belongs to its proposer and records the reviewer", async () => {
    const before = "old wording";
    const after = "new wording";
    const { url, docPath, snapshot } = await boot(before);
    const decision: DecisionEvent = {
      id: "accepted-suggestion-1",
      timestamp: "2026-08-12T10:02:00.000Z",
      action: "apply",
      actor: "Luis",
      source: "gui",
      target: { kind: "suggestion", id: "suggestion-1" },
      anchor: before,
      originalText: before,
      proposedText: after,
      resultingText: after,
      proposer: "Claude",
    };

    const saved = await fetch(`${url}/api/doc`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        content: after,
        baseVersion: snapshot.version,
        serverEpoch: snapshot.serverEpoch,
        documentPath: docPath,
        author: "Luis",
        decisionEvents: [decision],
      }),
    });
    expect(saved.status).toBe(200);

    const provenance = await fetch(`${url}/api/provenance?from=0&to=${after.length}`);
    expect(await provenance.json()).toMatchObject({
      segments: [{
        from: 0,
        to: after.length,
        author: "Claude",
        source: "suggestion",
        reviewedBy: "Luis",
        decisionId: decision.id,
      }],
    });
  });

  test("rebases accepted-suggestion audit and provenance through a concurrent prefix merge", async () => {
    const base = "Header\n{~~old~>new~~}\nnew\n";
    const mine = "Header\nnew\nnew\n";
    const theirs = "Agent note\n" + base;
    const { url, docPath, snapshot } = await boot(base);

    const agent = await fetch(`${url}/api/agent-write`, {
      method: "POST",
      headers,
      body: JSON.stringify({ base, content: theirs, documentPath: docPath, author: "Codex" }),
    });
    expect(agent.status).toBe(200);

    const beforeFrom = base.indexOf("{~~");
    const afterFrom = mine.indexOf("new");
    const decision: DecisionEvent = {
      id: "merged-suggestion-1",
      timestamp: "2026-08-14T10:02:00.000Z",
      action: "accept",
      actor: "Luis",
      source: "gui",
      target: {
        kind: "suggestion",
        id: "suggestion-merged",
        beforeFrom,
        beforeTo: beforeFrom + "{~~old~>new~~}".length,
        afterFrom,
        afterTo: afterFrom + 3,
      },
      anchor: "old",
      originalText: "old",
      proposedText: "new",
      resultingText: "new",
      proposer: "Claude",
    };

    const saved = await fetch(`${url}/api/doc`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        content: mine,
        baseVersion: snapshot.version,
        serverEpoch: snapshot.serverEpoch,
        documentPath: docPath,
        author: "Luis",
        decisionEvents: [decision],
      }),
    });
    expect(saved.status).toBe(200);
    const final = "Agent note\n" + mine;
    const finalFrom = final.indexOf("new");

    const decisions = await (await fetch(`${url}/api/decisions`)).json() as {
      decisionEvents: DecisionEvent[];
    };
    expect(decisions.decisionEvents[0].target).toMatchObject({
      afterFrom: finalFrom,
      afterTo: finalFrom + 3,
    });

    const provenance = await fetch(`${url}/api/provenance?from=${finalFrom}&to=${finalFrom + 3}`);
    expect(await provenance.json()).toMatchObject({
      segments: [{
        from: finalFrom,
        to: finalFrom + 3,
        author: "Claude",
        source: "suggestion",
        reviewedBy: "Luis",
        decisionId: decision.id,
      }],
    });
  });
});
