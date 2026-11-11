// PROTOTYPE (#31): three placements for "Send to agent" + the listening status,
// switchable with ?variant=A|B|C and the floating bar (dev builds only). The winner
// is folded into real code; the rest move to a throwaway branch.
//   A — header pill beside the save badge
//   B — under the comment rail's open-count, plus a Notify toggle in the composer
//   C — a review bar along the bottom of the document
import { useCallback, useEffect, useState } from "react";
import type { AgentStatus } from "../lib/types";

export type AgentVariant = "A" | "B" | "C";
const VARIANTS: AgentVariant[] = ["A", "B", "C"];
const NAMES: Record<AgentVariant, string> = { A: "Header pill", B: "Comment rail", C: "Review bar" };

export function readAgentVariant(): AgentVariant {
  const v = new URLSearchParams(location.search).get("variant");
  return v === "B" || v === "C" ? v : "A";
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function waitingTotal(status: AgentStatus | null) {
  return status ? status.waiting.comments + status.waiting.editRequests : 0;
}

/** POST /api/agent/wake and report what went. */
export function useSendToAgent(
  documentPath: string | null,
  onFeedback: (message: string, kind?: "info" | "error") => void,
) {
  const [sentAt, setSentAt] = useState<number | null>(null);
  useEffect(() => {
    if (sentAt === null) return;
    const t = setTimeout(() => setSentAt(null), 2500);
    return () => clearTimeout(t);
  }, [sentAt]);
  const send = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentPath }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { listening: number; sent: AgentStatus["waiting"] };
      const what = [
        body.sent.comments ? plural(body.sent.comments, "comment") : "",
        body.sent.editRequests ? plural(body.sent.editRequests, "edit request") : "",
      ]
        .filter(Boolean)
        .join(" and ");
      if (body.listening === 0) {
        onFeedback(`No agent is listening. ${what ? `${what[0].toUpperCase()}${what.slice(1)} will reach` : "Nothing was sent to"} the next agent that listens.`, "error");
      } else {
        onFeedback(`Sent ${what || "nothing"} to the agent.`);
        setSentAt(Date.now());
      }
    } catch (error) {
      onFeedback(`Could not reach the editor: ${(error as Error).message}`, "error");
    }
  }, [documentPath, onFeedback]);
  return { send, justSent: sentAt !== null };
}

function Dot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${on ? "bg-[var(--crit-ins)]" : "border border-[var(--faint)]"}`}
    />
  );
}

function listeningLabel(status: AgentStatus | null) {
  if (!status || status.listening === 0) return "No agent listening";
  return status.listening === 1 ? "Agent listening" : `${status.listening} agents listening`;
}

interface Props {
  status: AgentStatus | null;
  documentPath: string | null;
  notifyEach: boolean;
  onToggleNotifyEach: () => void;
  onFeedback: (message: string, kind?: "info" | "error") => void;
}

/** A — a joined pill in the header: status on the left, Send on the right. */
export function AgentHeaderPill({ status, documentPath, notifyEach, onToggleNotifyEach, onFeedback }: Props) {
  const { send, justSent } = useSendToAgent(documentPath, onFeedback);
  const [open, setOpen] = useState(false);
  const total = waitingTotal(status);
  return (
    <div className="relative flex h-7 items-stretch rounded-full border border-[var(--line-strong)] text-[12px]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-l-full px-2.5 text-[var(--muted)] hover:bg-[var(--line)]"
        title="Agent settings"
        aria-expanded={open}
      >
        <Dot on={(status?.listening ?? 0) > 0} />
        {listeningLabel(status)}
      </button>
      <button
        type="button"
        onClick={() => void send()}
        disabled={total === 0}
        className="flex items-center gap-1 rounded-r-full border-l border-[var(--line-strong)] px-2.5 font-medium text-[var(--ink)] hover:bg-[var(--line)] disabled:font-normal disabled:text-[var(--faint)] disabled:hover:bg-transparent"
        title={total ? "Send everything waiting to the agent as one message" : "Nothing is waiting on the agent"}
      >
        {justSent ? "Sent" : total ? `Send ${total} to agent` : "Nothing to send"}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-30 w-72 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3 text-[12px] shadow-lg">
            <label className="flex items-center justify-between gap-3 text-[13px] text-[var(--ink)]">
              Notify agent on each comment
              <input type="checkbox" checked={notifyEach} onChange={onToggleNotifyEach} />
            </label>
            <p className="mt-2 leading-snug text-[var(--muted)]">
              Off: comments wait until you press Send. Ask agent always notifies. An agent listens with{" "}
              <code>acm edit &lt;file.md&gt; --notify</code>.
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** B — a second pill under the rail's open-count. */
export function AgentRailPill({ status, documentPath, onFeedback }: Omit<Props, "notifyEach" | "onToggleNotifyEach">) {
  const { send, justSent } = useSendToAgent(documentPath, onFeedback);
  const total = waitingTotal(status);
  const listening = (status?.listening ?? 0) > 0;
  return (
    <button
      type="button"
      onClick={() => void send()}
      disabled={total === 0}
      className="mt-1.5 flex h-6 items-center gap-1.5 rounded-full border border-[var(--line-strong)] bg-[var(--panel)] px-2.5 text-[11px] font-medium text-[var(--ink)] shadow-sm hover:bg-[var(--line)] disabled:text-[var(--faint)] disabled:hover:bg-[var(--panel)]"
      title={`${listeningLabel(status)}. ${total ? "Send everything waiting as one message." : "Nothing is waiting on the agent."}`}
    >
      <Dot on={listening} />
      {justSent ? "Sent to agent" : total ? `Send ${total} to agent` : listening ? "Agent listening" : "No agent"}
    </button>
  );
}

/** B — the per-comment toggle beside the composer's Post buttons. */
export function ComposerNotifyToggle({ notifyEach, onToggleNotifyEach }: Pick<Props, "notifyEach" | "onToggleNotifyEach">) {
  return (
    <label className="mr-auto flex items-center gap-1.5 text-[11px] text-[var(--muted)]" title="Wake a listening agent on every comment">
      <input type="checkbox" checked={notifyEach} onChange={onToggleNotifyEach} />
      Notify agent
    </label>
  );
}

/** C — a review bar along the bottom of the document. */
export function AgentReviewBar({ status, documentPath, notifyEach, onToggleNotifyEach, onFeedback }: Props) {
  const { send, justSent } = useSendToAgent(documentPath, onFeedback);
  const total = waitingTotal(status);
  if (!status) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-[var(--line-strong)] bg-[var(--panel)] px-4 py-2 text-[13px] shadow-lg">
        <span className="flex items-center gap-1.5 text-[var(--muted)]">
          <Dot on={status.listening > 0} />
          {listeningLabel(status)}
        </span>
        <span className="text-[var(--ink)]">
          {total
            ? `${plural(total, "thread")} waiting (${plural(status.waiting.comments, "comment")}, ${plural(status.waiting.editRequests, "edit request")})`
            : "Nothing waiting on the agent"}
        </span>
        <label className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
          <input type="checkbox" checked={notifyEach} onChange={onToggleNotifyEach} />
          Notify on each comment
        </label>
        <button
          type="button"
          onClick={() => void send()}
          disabled={total === 0}
          className="rounded-md bg-[var(--accent)] px-3 py-1 text-[13px] font-medium text-[var(--panel)] hover:opacity-90 disabled:opacity-40"
        >
          {justSent ? "Sent" : "Done reviewing: send to agent"}
        </button>
      </div>
    </div>
  );
}

/** The prototype's variant switcher (dev builds only). */
export function AgentVariantSwitcher({ variant }: { variant: AgentVariant }) {
  const go = useCallback(
    (step: number) => {
      const next = VARIANTS[(VARIANTS.indexOf(variant) + step + VARIANTS.length) % VARIANTS.length];
      const url = new URL(location.href);
      url.searchParams.set("variant", next);
      location.assign(url.toString());
    },
    [variant],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable='true'], .cm-editor")) return;
      if (e.key === "ArrowLeft" && e.altKey) go(-1);
      if (e.key === "ArrowRight" && e.altKey) go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);
  if (!import.meta.env.DEV) return null;
  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full bg-black px-3 py-1.5 text-[12px] text-white shadow-lg">
      <button type="button" onClick={() => go(-1)} aria-label="Previous variant">←</button>
      <span>
        {variant} ({NAMES[variant]})
      </span>
      <button type="button" onClick={() => go(1)} aria-label="Next variant">→</button>
    </div>
  );
}
