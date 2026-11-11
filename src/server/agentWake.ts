// ── Waking the agent (#31) ─────────────────────────────────────────────────────
// The editor is the agent's listener. A thread is the agent's turn when the person
// has the last word in it (`awaitingAgent`, from the same threadsSummary `acm threads`
// prints). The person hands work over in three ways, each a one-line wake:
//   • ask     — Ask agent to edit (an edit request): always wakes
//   • comment — any new comment or reply from the person, when "Notify agent on
//               each comment" is on
//   • review  — Send to agent: one line summarising everything waiting
// `pending` is what `acm edit --wait` reports at once: threads handed over and not
// yet answered. A thread's state is its latest comment, so an answer (or a later
// reply, or an edit to that comment) makes it a new state rather than the same work.

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
  return `acm: ${e.event} #${e.threadId} ${e.author || "(no name)"}${anchor}`;
}

/** Threads that are the agent's turn, split into edit requests and everything else. */
export function waitingCounts(summary: ThreadSummary[]): WaitingCounts {
  const waiting = summary.filter((t) => t.awaitingAgent);
  const editRequests = waiting.filter((t) => t.editRequested).length;
  return { comments: waiting.length - editRequests, editRequests };
}

// The anchored span, the thread (its opening comment's id) and its latest comment's
// id. Comment ids hash their bytes, so a reply or an edit makes a new state, and
// the span keeps two threads with the same words apart ("tighten?" then "please
// suggest an edit" on two spans). Editing the opening comment also makes a new
// state, so it can report the thread again; a repeat beats a miss.
const stateKey = (t: ThreadSummary) => `${t.anchor ?? ""}\u0001${t.id}/${t.lastCommentId}`;

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

  /** Forget states no longer waiting. A comment id hashes its bytes, so the same
   *  words on another thread after a resolve (say "please suggest an edit") would
   *  otherwise match a retired state and stay silent. */
  private prune(summary: ThreadSummary[]) {
    const live = new Set(summary.filter((t) => t.awaitingAgent).map(stateKey));
    for (const set of [this.known, this.sent]) for (const key of set) if (!live.has(key)) set.delete(key);
  }

  /** Lines for threads that became the agent's turn since the last look. */
  detect(summary: ThreadSummary[], notifyEachComment: boolean): WakeEvent[] {
    this.prune(summary);
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

  /** Send to agent: hand over, as one line, everything waiting that no line has
   *  sent yet (the count the page's Send button shows). */
  review(summary: ThreadSummary[]): { event: "review" } & WaitingCounts {
    this.prune(summary);
    const unsent = summary.filter((t) => t.awaitingAgent && !this.sent.has(stateKey(t)));
    for (const t of unsent) {
      this.known.add(stateKey(t));
      this.sent.add(stateKey(t));
    }
    return { event: "review", ...waitingCounts(unsent) };
  }

  /** Threads waiting on the agent that no line has handed over yet. */
  toSend(summary: ThreadSummary[]): WaitingCounts {
    return waitingCounts(summary.filter((t) => !this.sent.has(stateKey(t))));
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
  // An empty Author is a real choice: the editor then writes comments with no name.
  const author = typeof settings.author === "string" ? settings.author.trim() : "You";
  return { humanAuthor: author, notifyEachComment: settings.notifyEachComment === true };
}
