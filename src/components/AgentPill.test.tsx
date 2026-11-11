// The header's agent pill (#31): whether an agent is listening, how much is
// waiting on it, and what the person is told after Send.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import AgentPill, { agentPillLabels, askFeedback, saveStatusOf, sendDecision, sendFeedback } from "./AgentPill";
import type { AgentStatus } from "../lib/types";

const status = (listening: number, comments: number, editRequests: number): AgentStatus => ({
  listening,
  toSend: { comments, editRequests },
});

describe("agentPillLabels", () => {
  test("before the first status read it claims nothing", () => {
    expect(agentPillLabels(null)).toEqual({
      listening: false,
      status: "Agent",
      send: "Nothing to send",
      canSend: false,
      sendTitle: "No agent is listening: start one with acm edit <file.md> --notify",
    });
  });

  test("no listener: Send is off and says how to start one, even with work waiting", () => {
    expect(agentPillLabels(status(0, 2, 1))).toEqual({
      listening: false,
      status: "No agent listening",
      send: "Send 3 to agent",
      canSend: false,
      sendTitle: "No agent is listening: start one with acm edit <file.md> --notify",
    });
  });

  test("an agent listening with work waiting: Send is on", () => {
    expect(agentPillLabels(status(1, 1, 0))).toEqual({
      listening: true,
      status: "Agent listening",
      send: "Send 1 to agent",
      canSend: true,
      sendTitle: "Send the comments waiting on the agent as one message",
    });
  });

  test("one listener, nothing waiting", () => {
    expect(agentPillLabels(status(1, 0, 0))).toEqual({
      listening: true,
      status: "Agent listening",
      send: "Nothing to send",
      canSend: false,
      sendTitle: "Nothing new to send to the agent",
    });
  });

  test("several listeners are counted", () => {
    expect(agentPillLabels(status(2, 1, 0)).status).toBe("2 agents listening");
  });
});

describe("sendFeedback", () => {
  test("names what went to a listening agent", () => {
    expect(sendFeedback({ listening: 1, sent: { comments: 2, editRequests: 1 } })).toEqual({
      message: "Sent 2 comments and 1 edit request to the agent.",
      kind: "info",
    });
  });

  test("says when nobody is listening and that the work will still arrive", () => {
    expect(sendFeedback({ listening: 0, sent: { comments: 1, editRequests: 0 } })).toEqual({
      message: "No agent is listening. 1 comment will reach the next agent that listens to this editor (acm edit --notify or --wait).",
      kind: "error",
    });
  });
});

describe("askFeedback", () => {
  test("says it added an edit request, and whether a listening agent heard it", () => {
    expect(askFeedback(status(1, 0, 0))).toEqual({
      message: "Added an edit request to the thread; the listening agent will be notified once it saves.",
      kind: "info",
    });
    expect(askFeedback(status(0, 0, 0))).toEqual({
      message: "Added an edit request to the thread. No agent is listening; the next one that listens to this editor will get it.",
      kind: "error",
    });
  });
});

describe("Send and the pending save (roborev round 2)", () => {
  test("Send goes only once the edits are on disk, and is cancelled when the save fails", () => {
    expect(
      ["saved", "unsaved", "saving", "offline", "conflict", "audit-error", "audit-recovery"].map((s) =>
        sendDecision(saveStatusOf(s, false)),
      ),
    ).toEqual(["send", "wait", "wait", "cancel", "cancel", "send", "send"]);
  });

  test("an audit state with edits still unsaved does not count as saved (roborev round 3)", () => {
    expect(["audit-error", "audit-recovery", "saved"].map((s) => sendDecision(saveStatusOf(s, true)))).toEqual([
      "cancel",
      "cancel",
      "wait",
    ]);
  });
});

describe("AgentPill markup", () => {
  test("shows the status and an enabled Send with the waiting count", () => {
    const html = renderToStaticMarkup(
      <AgentPill
        status={status(1, 2, 1)}
        documentPath="/doc.md"
        notifyEach={false}
        onToggleNotifyEach={() => {}}
        onFeedback={() => {}}
        saveStatus="saved"
        flushSave={() => {}}
      />,
    );
    expect(html).toContain("Agent listening");
    expect(html).toMatch(/<button[^>]*>Send 3 to agent<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Send 3 to agent/);
  });

  test("disables Send when nothing is waiting", () => {
    const html = renderToStaticMarkup(
      <AgentPill
        status={status(1, 0, 0)}
        documentPath="/doc.md"
        notifyEach={false}
        onToggleNotifyEach={() => {}}
        onFeedback={() => {}}
        saveStatus="saved"
        flushSave={() => {}}
      />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Nothing to send<\/button>/);
  });
});
