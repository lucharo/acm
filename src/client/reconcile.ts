// ── Save reconciliation (pure, testable) ──────────────────────────────────────
// The decision the editor makes when a save (PUT /api/doc) comes back. Extracted
// from useDocSync so it can be unit-tested in isolation — two independent adversarial
// reviews found data-loss bugs here, and the React hook around it was untested.
//
// THE INVARIANT THAT PREVENTS DATA LOSS: never advance `currentVersion` to a server
// version the editor buffer does NOT descend from. If we did, the next save would PUT
// `{buffer, baseVersion: that-version}`, the server would see `base === disk` and take
// its fast path, and the buffer would OVERWRITE content it never incorporated (an
// agent card, or edits made while this tab fell behind). So on ANY conflict we keep
// the version we sent against, and the next save re-merges server-side instead of
// fast-path-clobbering. We only advance on branches where the buffer is, or is made,
// a true descendant of the new version.

import { merge3 } from "../lib/merge";

export type SaveDecision =
  /** Response wasn't our protocol (non-JSON / missing version). Keep pending, don't advance. */
  | { kind: "failed" }
  /** A genuine conflict (server 409, or a same-line clash with keystrokes typed mid-save).
   *  Keep the buffer, do NOT advance the version — the next save re-merges server-side. */
  | { kind: "conflict" }
  /** Buffer matches what the server now holds. Clear pending; adopt server content if it merged. */
  | { kind: "saved"; version: number; adopt?: string }
  /** Server stored exactly what we sent but the user kept typing — persist the newer buffer. */
  | { kind: "reflush"; version: number }
  /** User kept typing AND the server merged in a concurrent write; the two are disjoint, so
   *  we rebased locally. Adopt the rebased buffer (contains both) and persist it. */
  | { kind: "rebased"; version: number; pending: string };

export function reconcileSave(args: {
  status: number;
  version: unknown; // data.version as received (validated here)
  serverContent: string | undefined; // data.content — the bytes the server now holds
  sent: string; // the content this PUT carried
  buffer: string | null; // pendingContent at response time (null once a save is confirmed)
}): SaveDecision {
  const { status, serverContent, sent, buffer } = args;
  if (typeof args.version !== "number") return { kind: "failed" };
  const version = args.version;

  // A true conflict from the server (overlap / cursor / stale / containment). The server
  // wrote nothing; our buffer still descends from the version we sent against, so DON'T
  // advance — let the next save re-merge against disk rather than fast-path over it.
  if (status === 409) return { kind: "conflict" };

  const merged = serverContent !== undefined && serverContent !== sent;

  // No keystrokes since we sent (or already confirmed): the buffer equals `sent`, which
  // the server has at `version` (possibly with a concurrent edit merged in → adopt it).
  if (buffer === null || buffer === sent) {
    return { kind: "saved", version, adopt: merged ? serverContent : undefined };
  }

  // The user kept typing during the round-trip.
  if (!merged) {
    // Server stored exactly `sent`; the buffer descends from it → safe to advance + persist.
    return { kind: "reflush", version };
  }
  // The server merged in a concurrent (agent) write. Rebase the newer keystrokes onto it
  // with the same primitive the server uses. Disjoint → both survive; same-line → conflict,
  // and we must NOT advance (the buffer lacks the merged-in content).
  const m = merge3(buffer, sent, serverContent!);
  return m.clean ? { kind: "rebased", version, pending: m.result } : { kind: "conflict" };
}
