// ── Agent pill (#31) ───────────────────────────────────────────────────────────
// A joined pill in the header: on the left whether an agent is listening (an
// `acm edit <file> --notify` or `--wait` attached to this editor; click for the
// Notify-on-each-comment setting), on the right Send, which hands everything
// waiting on the agent over as one wake line.
import { useCallback, useEffect, useState } from "react";
import type { AgentStatus } from "../lib/types";

type Feedback = (message: string, kind?: "info" | "error") => void;

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function agentPillLabels(status: AgentStatus | null) {
  const total = status ? status.toSend.comments + status.toSend.editRequests : 0;
  const listening = (status?.listening ?? 0) > 0;
  return {
    listening,
    status: !status
      ? "Agent"
      : status.listening === 0
        ? "No agent listening"
        : status.listening === 1
          ? "Agent listening"
          : `${status.listening} agents listening`,
    send: total > 0 ? `Send ${total} to agent` : "Nothing to send",
    canSend: total > 0,
  };
}

/** What the person is told after Send. */
export function sendFeedback(body: { listening: number; sent: AgentStatus["toSend"] }): {
  message: string;
  kind: "info" | "error";
} {
  const what = [
    body.sent.comments ? plural(body.sent.comments, "comment") : "",
    body.sent.editRequests ? plural(body.sent.editRequests, "edit request") : "",
  ]
    .filter(Boolean)
    .join(" and ");
  if (body.listening === 0) {
    return {
      message: `No agent is listening. ${what || "Nothing"} will reach the next agent that listens to this editor (acm edit --notify or --wait).`,
      kind: "error",
    };
  }
  return { message: `Sent ${what || "nothing"} to the agent.`, kind: "info" };
}

/** What the person is told after Ask agent to edit. The button only adds an edit
 *  request to the thread; a listening agent is notified, and picks it up by the
 *  usual rules (acm threads), so the message claims no more than that. */
export function askFeedback(status: AgentStatus | null): { message: string; kind: "info" | "error" } {
  return (status?.listening ?? 0) > 0
    ? { message: "Added an edit request to the thread; the listening agent will be notified once it saves.", kind: "info" }
    : {
        message: "Added an edit request to the thread. No agent is listening; the next one that listens to this editor will get it.",
        kind: "error",
      };
}

/** Whether the editor's buffer is on disk: Send must not wake the agent before
 *  the comment it is about has saved (the server reads the file). */
export type SaveStatus = "saved" | "pending" | "failed";

/** `unsavedContent`: the editor still holds bytes the server has not confirmed. The
 *  audit-* badges can show while that is true (an outbox storage failure before the
 *  save), so they count as saved only when nothing is held. */
export function saveStatusOf(saveState: string, unsavedContent: boolean): SaveStatus {
  if (saveState === "unsaved" || saveState === "saving") return "pending";
  if (saveState === "offline" || saveState === "conflict") return "failed";
  if (!unsavedContent) return "saved";
  return saveState === "saved" ? "pending" : "failed";
}

/** What a Send click (or one waiting on a save) does now. */
export function sendDecision(saveStatus: SaveStatus): "send" | "wait" | "cancel" {
  return saveStatus === "saved" ? "send" : saveStatus === "pending" ? "wait" : "cancel";
}

export const SEND_NOT_SAVED = "Not sent: your latest edits have not saved. Send again once the editor shows Saved.";

interface AgentPillProps {
  status: AgentStatus | null;
  documentPath: string | null;
  notifyEach: boolean;
  onToggleNotifyEach: () => void;
  onFeedback: Feedback;
  /** Send saves first, so the agent hears about the comment you just wrote. */
  saveStatus: SaveStatus;
  flushSave: () => void;
}

export default function AgentPill({
  status,
  documentPath,
  notifyEach,
  onToggleNotifyEach,
  onFeedback,
  saveStatus,
  flushSave,
}: AgentPillProps) {
  const [open, setOpen] = useState(false);
  const [justSent, setJustSent] = useState(false);
  const [queued, setQueued] = useState(false);
  useEffect(() => {
    if (!justSent) return;
    const t = setTimeout(() => setJustSent(false), 2500);
    return () => clearTimeout(t);
  }, [justSent]);
  const labels = agentPillLabels(status);

  const send = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentPath }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const feedback = sendFeedback(await res.json());
      onFeedback(feedback.message, feedback.kind);
      if (feedback.kind === "info") setJustSent(true);
    } catch (error) {
      onFeedback(`Could not reach the editor: ${(error as Error).message}`, "error");
    }
  }, [documentPath, onFeedback]);

  // A Send clicked while a save is pending waits for the save, then goes; a save
  // that fails instead (offline, conflict) cancels it rather than send old bytes.
  useEffect(() => {
    if (!queued) return;
    const decision = sendDecision(saveStatus);
    if (decision === "wait") return;
    setQueued(false);
    if (decision === "send") void send();
    else onFeedback(SEND_NOT_SAVED, "error");
  }, [queued, saveStatus, send, onFeedback]);
  const onSend = () => {
    const decision = sendDecision(saveStatus);
    if (decision === "send") return void send();
    if (decision === "cancel") return onFeedback(SEND_NOT_SAVED, "error");
    flushSave();
    setQueued(true);
  };

  return (
    <div className="relative flex h-7 items-stretch rounded-full border border-[var(--line-strong)] text-[12px]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-l-full px-2.5 text-[var(--muted)] hover:bg-[var(--line)]"
        title="Agent: who is listening, and when it is notified"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${labels.listening ? "bg-[var(--crit-ins)]" : "border border-[var(--faint)]"}`}
        />
        <span className="hidden sm:inline">{labels.status}</span>
      </button>
      <button
        type="button"
        onClick={onSend}
        disabled={!labels.canSend || queued}
        className="flex items-center rounded-r-full border-l border-[var(--line-strong)] px-2.5 font-medium text-[var(--ink)] hover:bg-[var(--line)] disabled:font-normal disabled:text-[var(--faint)] disabled:hover:bg-transparent"
        title={labels.canSend ? "Send the comments waiting on the agent as one message" : "Nothing new to send to the agent"}
      >{queued ? "Saving…" : justSent ? "Sent" : labels.send}</button>
      {open ? (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Agent"
            className="absolute right-0 top-9 z-30 w-72 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3 text-[12px] shadow-lg"
          >
            <label className="flex items-center justify-between gap-3 text-[13px] text-[var(--ink)]">
              Notify agent on each comment
              <input type="checkbox" checked={notifyEach} onChange={onToggleNotifyEach} />
            </label>
            <p className="mt-2 leading-snug text-[var(--muted)]">
              Off: comments wait until you press Send. Ask agent to edit always notifies. An agent listens with{" "}
              <code>acm edit &lt;file.md&gt; --notify</code>.
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
