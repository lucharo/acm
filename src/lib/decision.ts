// Canonical audit model for review decisions. Both the browser and CLI emit this
// exact shape; the server persists it outside the published Markdown document.

import type { CommentThread, CommentToken, SuggestionToken } from "./types";
import { textChangeHunks } from "./merge";
import {
  groupThreads,
  resolveAnchorEdit,
  scanTokens,
  suggestionGroupId,
  suggestionGroupEdits,
  suggestionReplacement,
  suggestionThreadEdit,
  threadAnchorHighlightFor,
} from "./criticmarkup";

export const DECISION_ACTIONS = ["accept", "reject", "resolve", "apply", "apply-resolve"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export const DECISION_SOURCES = ["gui", "cli"] as const;
export type DecisionSource = (typeof DECISION_SOURCES)[number];

export const DECISION_TARGET_KINDS = ["comment", "thread", "suggestion", "group"] as const;
export type DecisionTargetKind = (typeof DECISION_TARGET_KINDS)[number];

export interface DecisionTarget {
  kind: DecisionTargetKind;
  /** Stable content-derived identity used by the review surface. */
  id: string;
  threadId?: string;
  commentId?: string;
  groupId?: string;
  memberIds?: string[];
  /** Complete edit range in the document before the decision lands. */
  beforeFrom?: number;
  beforeTo?: number;
  /** Resulting accepted/rejected text range after the decision lands. */
  afterFrom?: number;
  afterTo?: number;
}

/**
 * One append-only record of a successful review decision. Text fields are
 * explicit `null` when they do not apply, so JSONL remains inspectable and every
 * producer emits the same complete shape.
 */
export interface DecisionEvent {
  id: string;
  timestamp: string;
  action: DecisionAction;
  actor: string;
  source: DecisionSource;
  target: DecisionTarget;
  anchor: string;
  originalText: string | null;
  proposedText: string | null;
  resultingText: string | null;
  /** Author of a structured suggestion. The reviewer remains `actor`. */
  proposer?: string | null;
}

/** Pending audit changes emitted alongside one editor document transaction. */
export interface DecisionQueueUpdate {
  enqueue: DecisionEvent[];
  cancel: DecisionEvent[];
}

export interface DecisionAuditReceipt {
  status: "persisted";
  decisionEventIds: string[];
}

export type DecisionEventDraft = Omit<DecisionEvent, "id" | "timestamp">;

const ACTIONS = new Set<string>(DECISION_ACTIONS);
const SOURCES = new Set<string>(DECISION_SOURCES);
const TARGET_KINDS = new Set<string>(DECISION_TARGET_KINDS);

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isDecisionTarget(value: unknown): value is DecisionTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  const validRange = (from: unknown, to: unknown) =>
    (from === undefined && to === undefined) ||
    (Number.isInteger(from) && Number.isInteger(to) && Number(from) >= 0 && Number(to) >= Number(from));
  return (
    typeof target.kind === "string" &&
    TARGET_KINDS.has(target.kind) &&
    typeof target.id === "string" &&
    target.id.length > 0 &&
    optionalString(target.threadId) &&
    optionalString(target.commentId) &&
    optionalString(target.groupId) &&
    (target.memberIds === undefined ||
      (Array.isArray(target.memberIds) && target.memberIds.every((id) => typeof id === "string" && id.length > 0))) &&
    validRange(target.beforeFrom, target.beforeTo) &&
    validRange(target.afterFrom, target.afterTo)
  );
}

/** Exactly what createDecisionEvent stamps. Date.parse alone also takes "foo 12"
 * and 31 February, neither of which any ACM producer can have written. */
function isCanonicalTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function isDecisionEvent(value: unknown): value is DecisionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    event.id.trim().length > 0 &&
    isCanonicalTimestamp(event.timestamp) &&
    typeof event.action === "string" &&
    ACTIONS.has(event.action) &&
    typeof event.actor === "string" &&
    event.actor.trim().length > 0 &&
    typeof event.source === "string" &&
    SOURCES.has(event.source) &&
    isDecisionTarget(event.target) &&
    typeof event.anchor === "string" &&
    nullableString(event.originalText) &&
    nullableString(event.proposedText) &&
    nullableString(event.resultingText) &&
    (event.proposer === undefined ||
      event.proposer === null ||
      (typeof event.proposer === "string" && event.proposer.trim().length > 0))
  );
}

function defaultDecisionActor(source: DecisionSource): string {
  return source === "gui" ? "You" : "acm-cli";
}

/** Read an event already written by an earlier ACM version. New submissions
 * remain strict, but legacy whitespace-only actors are recoverable because the
 * source still provides an inspectable fallback identity. */
export function parsePersistedDecisionEvent(value: unknown): DecisionEvent | null {
  if (isDecisionEvent(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.actor !== "string" ||
    event.actor.trim().length > 0 ||
    (event.source !== "gui" && event.source !== "cli")
  ) {
    return null;
  }
  const normalized = { ...event, actor: defaultDecisionActor(event.source) };
  return isDecisionEvent(normalized) ? normalized : null;
}

export function createDecisionEvent(draft: DecisionEventDraft): DecisionEvent {
  const actor = draft.actor.trim() || defaultDecisionActor(draft.source);
  return {
    id: globalThis.crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...draft,
    actor,
  };
}

function mapPositionThroughDocumentChange(
  before: string,
  after: string,
  position: number,
  association: -1 | 1,
): number | null {
  if (!Number.isInteger(position) || position < 0 || position > before.length) return null;
  let offset = 0;
  for (const hunk of textChangeHunks(before, after)) {
    if (hunk.beforeFrom === hunk.beforeTo && position === hunk.beforeFrom) {
      return association < 0 ? hunk.afterFrom : hunk.afterTo;
    }
    if (position <= hunk.beforeFrom) return position + offset;
    if (position < hunk.beforeTo) {
      return association < 0 ? hunk.afterFrom : hunk.afterTo;
    }
    if (position === hunk.beforeTo) return hunk.afterTo;
    offset = hunk.afterTo - hunk.beforeTo;
  }
  return position + offset;
}

function mapTargetRange(
  event: DecisionEvent,
  before: string,
  after: string,
  prefix: "before" | "after",
): DecisionEvent {
  const fromKey = `${prefix}From` as "beforeFrom" | "afterFrom";
  const toKey = `${prefix}To` as "beforeTo" | "afterTo";
  const from = event.target[fromKey];
  const to = event.target[toKey];
  if (from === undefined || to === undefined) return event;
  const mappedFrom = mapPositionThroughDocumentChange(before, after, from, 1);
  const mappedTo = from === to
    ? mappedFrom
    : mapPositionThroughDocumentChange(before, after, to, -1);
  if (mappedFrom === null || mappedTo === null) {
    const { [fromKey]: _from, [toKey]: _to, ...target } = event.target;
    return { ...event, target };
  }
  const normalizedTo = Math.max(mappedFrom, mappedTo);
  if (mappedFrom === from && normalizedTo === to) return event;
  return {
    ...event,
    target: { ...event.target, [fromKey]: mappedFrom, [toKey]: normalizedTo },
  };
}

/** Carry pending result coordinates through edits made before the debounced save. */
export function rebaseDecisionEventsAfterChange(
  events: readonly DecisionEvent[],
  before: string,
  after: string,
): DecisionEvent[] {
  if (before === after) return events as DecisionEvent[];
  return events.map((event) => mapTargetRange(event, before, after, "after"));
}

/** Rebase transaction-time coordinates onto the exact snapshots committed by the server. */
export function rebaseDecisionEventsForCommit(
  events: readonly DecisionEvent[],
  documents: { base: string; mine: string; theirs: string; committed: string },
): DecisionEvent[] {
  const afterRebased = rebaseDecisionEventsAfterChange(
    events,
    documents.mine,
    documents.committed,
  );
  return afterRebased.map((event) =>
    mapTargetRange(event, documents.base, documents.theirs, "before")
  );
}

/** A write is audit-complete only when the server explicitly acknowledges the
 * exact event ids it was asked to persist. This prevents a newer GUI/CLI from
 * silently trusting an older server that accepted the document but ignored the
 * decisionEvents field. */
export function decisionEventsAcknowledged(
  events: readonly DecisionEvent[],
  audit: { status?: unknown; decisionEventIds?: unknown } | null | undefined,
): boolean {
  if (events.length === 0) return true;
  return (
    audit?.status === "persisted" &&
    Array.isArray(audit.decisionEventIds) &&
    audit.decisionEventIds.length === events.length &&
    audit.decisionEventIds.every((id, index) => id === events[index].id)
  );
}

/** Build the shared event for native CriticMarkup insert/delete/substitute. */
export function inlineSuggestionDecision(
  token: SuggestionToken,
  mode: "accept" | "reject",
  actor: string,
  source: DecisionSource,
): DecisionEvent {
  let originalText: string;
  let proposedText: string;
  if (token.type === "insert") {
    originalText = "";
    proposedText = token.inner;
  } else if (token.type === "delete") {
    originalText = token.inner;
    proposedText = "";
  } else {
    originalText = token.oldText;
    proposedText = token.newText;
  }
  return createDecisionEvent({
    action: mode,
    actor,
    source,
    target: {
      kind: "suggestion",
      id: token.id,
      beforeFrom: token.from,
      beforeTo: token.to,
      afterFrom: token.from,
      afterTo: token.from + (mode === "accept" ? proposedText.length : originalText.length),
    },
    anchor: originalText || proposedText,
    originalText,
    proposedText,
    resultingText: mode === "accept" ? proposedText : originalText,
  });
}

/** Build the shared event for a SUGGEST-card decision, or null if its anchor no
 * longer resolves. `action` distinguishes CLI Accept from GUI Apply. */
export function structuredSuggestionDecision(
  content: string,
  comment: CommentToken,
  mode: "accept" | "reject",
  action: "accept" | "reject" | "apply" | "apply-resolve",
  actor: string,
  source: DecisionSource,
): DecisionEvent | null {
  const proposedText = suggestionReplacement(comment.body);
  if (proposedText === null) return null;
  const tokens = scanTokens(content);
  const comments = tokens.filter((token): token is CommentToken => token.type === "comment");
  const threads = groupThreads(comments, content);
  const thread = threads.find((candidate) => candidate.comments.some((item) => item.id === comment.id));
  const highlight = threadAnchorHighlightFor(content, comment, tokens, threads);
  if (!thread || !highlight || highlight.type !== "highlight") return null;
  const groupId = suggestionGroupId(comment.body);
  const discussion = action === "apply-resolve" ? "resolve-thread" : "keep-discussion";
  const edit = suggestionThreadEdit(content, comment, mode, discussion);
  if (!edit) return null;
  const resultingText = mode === "accept" ? proposedText : highlight.inner;
  const resultOffset = resultingText.length === 0 ? 0 : edit.insert.indexOf(resultingText);
  if (resultOffset < 0) return null;
  return createDecisionEvent({
    action,
    actor,
    source,
    target: {
      kind: "suggestion",
      id: comment.id,
      threadId: thread.id,
      ...(groupId ? { groupId } : {}),
      beforeFrom: edit.from,
      beforeTo: edit.to,
      afterFrom: edit.from + resultOffset,
      afterTo: edit.from + resultOffset + resultingText.length,
    },
    anchor: highlight.inner,
    originalText: highlight.inner,
    proposedText,
    resultingText,
    proposer: comment.author,
  });
}

/** Events for exactly the group members that the shared edit planner will apply;
 * overlapping/unresolvable members are omitted alongside their skipped edits.
 * `unticked` leaves those member ids out of both (#25), as in suggestionGroupEdits. */
export function structuredSuggestionGroupDecisions(
  content: string,
  groupId: string,
  mode: "accept" | "reject",
  action: "accept" | "reject" | "apply" | "apply-resolve",
  actor: string,
  source: DecisionSource,
  unticked?: ReadonlySet<string>,
): DecisionEvent[] {
  const discussion = action === "apply-resolve" ? "resolve-thread" : "keep-discussion";
  const { edits } = suggestionGroupEdits(content, groupId, mode, discussion, unticked);
  const comments = scanTokens(content).filter(
    (token): token is CommentToken => token.type === "comment",
  );
  const remainingEdits = [...edits];
  return comments
    .filter((comment) => suggestionGroupId(comment.body) === groupId && !unticked?.has(comment.id))
    .flatMap((comment) => {
      const edit = suggestionThreadEdit(content, comment, mode, discussion);
      if (!edit) return [];
      const editIndex = remainingEdits.findIndex(
        (candidate) =>
          candidate.from === edit.from &&
          candidate.to === edit.to &&
          candidate.insert === edit.insert,
      );
      if (editIndex < 0) return [];
      remainingEdits.splice(editIndex, 1);
      const event = structuredSuggestionDecision(content, comment, mode, action, actor, source);
      if (!event || event.target.groupId !== groupId) return [];
      const shift = edits
        .filter((candidate) => candidate.to <= edit.from)
        .reduce((total, candidate) => total + candidate.insert.length - (candidate.to - candidate.from), 0);
      const localFrom = (event.target.afterFrom ?? edit.from) - edit.from;
      const localTo = (event.target.afterTo ?? edit.from) - edit.from;
      return [{
        ...event,
        target: {
          ...event.target,
          afterFrom: edit.from + shift + localFrom,
          afterTo: edit.from + shift + localTo,
        },
      }];
    });
}

/** Build the shared event for resolving a whole thread. */
export function threadResolveDecision(
  content: string,
  thread: CommentThread,
  actor: string,
  source: DecisionSource,
): DecisionEvent {
  const root = thread.comments[0];
  const tokens = scanTokens(content);
  const highlight = root ? threadAnchorHighlightFor(content, root, tokens, [thread]) : null;
  const edit = resolveAnchorEdit(content, thread.from, thread.to);
  return createDecisionEvent({
    action: "resolve",
    actor,
    source,
    target: {
      kind: "thread",
      id: thread.id,
      threadId: thread.id,
      ...(root ? { commentId: root.id } : {}),
    },
    anchor: highlight?.type === "highlight" ? highlight.inner : "",
    originalText: content.slice(edit.from, edit.to),
    proposedText: null,
    resultingText: edit.insert,
  });
}

/** Build the event for the overview's single-comment Resolve action. */
export function commentResolveDecision(
  content: string,
  comment: CommentToken,
  actor: string,
  source: DecisionSource,
): DecisionEvent {
  const tokens = scanTokens(content);
  const comments = tokens.filter((token): token is CommentToken => token.type === "comment");
  const threads = groupThreads(comments, content);
  const thread = threads.find((candidate) => candidate.comments.some((item) => item.id === comment.id));
  const highlight = threadAnchorHighlightFor(content, comment, tokens, threads);
  const edit = resolveAnchorEdit(content, comment.from, comment.to);
  return createDecisionEvent({
    action: "resolve",
    actor,
    source,
    target: {
      kind: "comment",
      id: comment.id,
      commentId: comment.id,
      ...(thread ? { threadId: thread.id } : {}),
    },
    anchor: highlight?.type === "highlight" ? highlight.inner : "",
    originalText: content.slice(edit.from, edit.to),
    proposedText: null,
    resultingText: edit.insert,
  });
}
