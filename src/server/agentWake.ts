// ── Waking the agent (#31) ─────────────────────────────────────────────────────
// The editor is the agent's listener. A thread is the agent's turn when the person
// has the last word in it (`awaitingAgent`, from the same threadsSummary `acm threads`
// prints). The person hands work over in three ways, each a one-line wake:
//   • ask     — Ask agent (an edit request): always wakes
//   • comment — any new comment or reply from the person, when "Notify agent on
//               each comment" is on
//   • review  — Send to agent: one line summarising everything waiting
// `pending` is what `acm edit --wait` reports at once: threads handed over and not
// yet answered. A thread is identified by its id plus its comment count, so an
// answer (or a later reply) makes it a new state rather than the same work again.

import type { ThreadSummary } from "../lib/agentEdits";

export interface WaitingCounts {
  comments: number;
  editRequests: number;
}

export type WakeEvent =
  | { event: "comment" | "ask" | "pending"; threadId: string; author: string; anchor: string | null }
  | ({ event: "review" } & WaitingCounts);

const ANCHOR_MAX = 60;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One stdout line: `acm: <event> #<thread> <author> "<anchor>"`, or the review summary. */
export function formatWakeLine(e: WakeEvent): string {
  if (e.event === "review") {
    const total = e.comments + e.editRequests;
    return `acm: review ${plural(total, "thread")} waiting (${plural(e.comments, "comment")}, ${plural(e.editRequests, "edit request")}) - run acm threads`;
  }
  const flat = e.anchor?.replace(/\s+/g, " ").trim();
  const anchor = flat ? ` "${flat.length > ANCHOR_MAX ? `${flat.slice(0, ANCHOR_MAX - 1)}…` : flat}"` : "";
  return `acm: ${e.event} #${e.threadId} ${e.author}${anchor}`;
}

/** Threads that are the agent's turn, split into edit requests and everything else. */
export function waitingCounts(summary: ThreadSummary[]): WaitingCounts {
  const waiting = summary.filter((t) => t.awaitingAgent);
  const editRequests = waiting.filter((t) => t.editRequested).length;
  return { comments: waiting.length - editRequests, editRequests };
}

const stateKey = (t: ThreadSummary) => `${t.id}/${t.count}`;

function threadEvent(event: "comment" | "ask" | "pending", t: ThreadSummary): WakeEvent {
  return { event, threadId: t.id, author: t.lastAuthor, anchor: t.anchor };
}

export class AgentWake {
  /** Waiting thread states already seen, so each is reported once. */
  private known: Set<string>;
  /** Waiting thread states handed to the agent (a line went out for them). */
  private sent = new Set<string>();

  /** Threads already waiting when the editor starts are known, not new. */
  constructor(initial: ThreadSummary[]) {
    this.known = new Set(initial.filter((t) => t.awaitingAgent).map(stateKey));
  }

  /** Lines for threads that became the agent's turn since the last look. */
  detect(summary: ThreadSummary[], notifyEachComment: boolean): WakeEvent[] {
    const events: WakeEvent[] = [];
    for (const t of summary) {
      if (!t.awaitingAgent) continue;
      const key = stateKey(t);
      if (this.known.has(key)) continue;
      this.known.add(key);
      if (t.editRequested) events.push(threadEvent("ask", t));
      else if (notifyEachComment) events.push(threadEvent("comment", t));
      else continue;
      this.sent.add(key);
    }
    return events;
  }

  /** Send to agent: hand over everything waiting as one line. */
  review(summary: ThreadSummary[]): { event: "review" } & WaitingCounts {
    for (const t of summary) {
      if (!t.awaitingAgent) continue;
      this.known.add(stateKey(t));
      this.sent.add(stateKey(t));
    }
    return { event: "review", ...waitingCounts(summary) };
  }

  /** Handed-over threads the agent has not answered yet. */
  pending(summary: ThreadSummary[]): ThreadSummary[] {
    return summary.filter((t) => t.awaitingAgent && this.sent.has(stateKey(t)));
  }

  /** `pending` as wake lines, for a `--wait` that starts after the hand-over. */
  pendingEvents(summary: ThreadSummary[]): WakeEvent[] {
    return this.pending(summary).map((t) => threadEvent("pending", t));
  }
}

/** The person's name and the notify-each setting, from settings.json's `settings`. */
export function wakeSettings(config: Record<string, unknown>): { humanAuthor: string; notifyEachComment: boolean } {
  const settings = (config.settings ?? {}) as { author?: unknown; notifyEachComment?: unknown };
  const author = typeof settings.author === "string" && settings.author.trim() ? settings.author.trim() : "You";
  return { humanAuthor: author, notifyEachComment: settings.notifyEachComment === true };
}
