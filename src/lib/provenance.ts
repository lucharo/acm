import type { DecisionEvent } from "./decision";
import { scanTokens } from "./criticmarkup";
import { textChangeHunks, type TextChangeHunk } from "./merge";

export const PROVENANCE_SOURCES = [
  "baseline",
  "human",
  "agent",
  "external",
  "suggestion",
  "restore",
] as const;

export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

export interface ProvenanceAttribution {
  author: string;
  source: ProvenanceSource;
  timestamp: string;
  reviewedBy?: string;
  decisionId?: string;
  operation?: string;
}

export interface ProvenanceSegment extends ProvenanceAttribution {
  from: number;
  to: number;
}

export function baselineProvenance(
  content: string,
  attribution: ProvenanceAttribution,
): ProvenanceSegment[] {
  return content.length === 0 ? [] : [{ from: 0, to: content.length, ...attribution }];
}

function sameAttribution(left: ProvenanceAttribution, right: ProvenanceAttribution): boolean {
  return left.author === right.author &&
    left.source === right.source &&
    left.timestamp === right.timestamp &&
    left.reviewedBy === right.reviewedBy &&
    left.decisionId === right.decisionId &&
    left.operation === right.operation;
}

export function normalizeProvenance(segments: readonly ProvenanceSegment[]): ProvenanceSegment[] {
  const sorted = segments
    .filter((segment) => segment.to > segment.from)
    .map((segment) => ({ ...segment }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const normalized: ProvenanceSegment[] = [];
  for (const segment of sorted) {
    const previous = normalized.at(-1);
    if (previous && previous.to === segment.from && sameAttribution(previous, segment)) {
      previous.to = segment.to;
    } else {
      normalized.push(segment);
    }
  }
  return normalized;
}

function coversDocument(segments: readonly ProvenanceSegment[], length: number): boolean {
  if (length === 0) return segments.length === 0;
  let cursor = 0;
  for (const segment of segments) {
    if (segment.from !== cursor || segment.to <= segment.from || segment.to > length) return false;
    cursor = segment.to;
  }
  return cursor === length;
}

function copyStableRange(
  segments: readonly ProvenanceSegment[],
  beforeFrom: number,
  beforeTo: number,
  afterFrom: number,
): ProvenanceSegment[] {
  const shift = afterFrom - beforeFrom;
  return segments.flatMap((segment) => {
    const from = Math.max(segment.from, beforeFrom);
    const to = Math.min(segment.to, beforeTo);
    return to > from ? [{ ...segment, from: from + shift, to: to + shift }] : [];
  });
}

function changedRangeOverlaps(
  hunk: TextChangeHunk,
  beforeFrom: number,
  beforeTo: number,
  afterFrom: number,
  afterTo: number,
): boolean {
  const beforeOverlap = beforeTo > beforeFrom && hunk.beforeTo > beforeFrom && hunk.beforeFrom < beforeTo;
  const afterOverlap = afterTo > afterFrom && hunk.afterTo > afterFrom && hunk.afterFrom < afterTo;
  const insertionAtRange = hunk.beforeFrom === hunk.beforeTo &&
    hunk.beforeFrom >= beforeFrom && hunk.beforeFrom <= beforeTo;
  return beforeOverlap || afterOverlap || insertionAtRange;
}

function uniqueOccurrence(text: string, needle: string): number | null {
  if (!needle) return null;
  const first = text.indexOf(needle);
  if (first < 0 || text.indexOf(needle, first + 1) >= 0) return null;
  return first;
}

function exactSuggestionRange(
  before: string,
  after: string,
  event: DecisionEvent,
): { beforeFrom: number; beforeTo: number; afterFrom: number; afterTo: number } | null {
  const { beforeFrom, beforeTo, afterFrom, afterTo } = event.target;
  if (
    Number.isInteger(beforeFrom) &&
    Number.isInteger(beforeTo) &&
    Number.isInteger(afterFrom) &&
    Number.isInteger(afterTo) &&
    beforeFrom! >= 0 &&
    beforeTo! >= beforeFrom! &&
    beforeTo! <= before.length &&
    afterFrom! >= 0 &&
    afterTo! >= afterFrom! &&
    afterTo! <= after.length &&
    after.slice(afterFrom, afterTo) === event.proposedText
  ) {
    return { beforeFrom: beforeFrom!, beforeTo: beforeTo!, afterFrom: afterFrom!, afterTo: afterTo! };
  }
  if (
    beforeFrom !== undefined ||
    beforeTo !== undefined ||
    afterFrom !== undefined ||
    afterTo !== undefined
  ) {
    return null;
  }
  if (event.originalText === null || event.proposedText === null) return null;
  const legacyBeforeFrom = uniqueOccurrence(before, event.originalText);
  const legacyAfterFrom = uniqueOccurrence(after, event.proposedText);
  if (legacyBeforeFrom === null || legacyAfterFrom === null) return null;
  return {
    beforeFrom: legacyBeforeFrom,
    beforeTo: legacyBeforeFrom + event.originalText.length,
    afterFrom: legacyAfterFrom,
    afterTo: legacyAfterFrom + event.proposedText.length,
  };
}

function nativeProposalSourceRange(
  before: string,
  event: DecisionEvent,
): { from: number; to: number } | null {
  const token = scanTokens(before).find((candidate) =>
    candidate.id === event.target.id &&
    (candidate.type === "insert" || candidate.type === "substitute")
  );
  if (!token || (token.type !== "insert" && token.type !== "substitute")) return null;
  if (token.type === "insert") {
    return { from: token.from + 3, to: token.from + 3 + token.inner.length };
  }
  const from = token.from + 3 + token.oldText.length + 2;
  return { from, to: from + token.newText.length };
}

function suggestionRanges(
  before: string,
  after: string,
  hunks: readonly TextChangeHunk[],
  current: readonly ProvenanceSegment[],
  events: readonly DecisionEvent[],
): Array<{ from: number; to: number; attribution: ProvenanceAttribution }> {
  return events.flatMap((event) => {
    if (
      !["accept", "apply", "apply-resolve"].includes(event.action) ||
      event.proposedText === null ||
      event.resultingText !== event.proposedText ||
      event.proposedText.length === 0 ||
      event.originalText === null
    ) {
      return [];
    }
    const range = exactSuggestionRange(before, after, event);
    if (!range) return [];
    const { beforeFrom, beforeTo, afterFrom, afterTo } = range;
    if (!hunks.some((hunk) => changedRangeOverlaps(hunk, beforeFrom, beforeTo, afterFrom, afterTo))) {
      return [];
    }
    const proposer = event.proposer?.trim();
    if (proposer) {
      return [{
        from: afterFrom,
        to: afterTo,
        attribution: {
          author: proposer,
          source: "suggestion" as const,
          timestamp: event.timestamp,
          reviewedBy: event.actor,
          decisionId: event.id,
        },
      }];
    }
    const proposalSource = nativeProposalSourceRange(before, event);
    if (!proposalSource || proposalSource.to - proposalSource.from !== afterTo - afterFrom) return [];
    return current.flatMap((segment) => {
      const sourceFrom = Math.max(segment.from, proposalSource.from);
      const sourceTo = Math.min(segment.to, proposalSource.to);
      if (sourceTo <= sourceFrom) return [];
      return [{
        from: afterFrom + sourceFrom - proposalSource.from,
        to: afterFrom + sourceTo - proposalSource.from,
        attribution: {
          author: segment.author,
          source: "suggestion" as const,
          timestamp: event.timestamp,
          reviewedBy: event.actor,
          decisionId: event.id,
        },
      }];
    });
  });
}

function overlayAttribution(
  segments: readonly ProvenanceSegment[],
  from: number,
  to: number,
  attribution: ProvenanceAttribution,
): ProvenanceSegment[] {
  const overlaid: ProvenanceSegment[] = [];
  for (const segment of segments) {
    if (segment.to <= from || segment.from >= to) {
      overlaid.push({ ...segment });
      continue;
    }
    if (segment.from < from) overlaid.push({ ...segment, to: from });
    overlaid.push({
      from: Math.max(segment.from, from),
      to: Math.min(segment.to, to),
      ...attribution,
    });
    if (segment.to > to) overlaid.push({ ...segment, from: to });
  }
  return normalizeProvenance(overlaid);
}

/** Carry range authorship through a document rewrite. Unchanged bytes retain their
 * attribution; each changed hunk belongs to the writer, except accepted structured
 * suggestions, whose proposed range belongs to the proposer and records the reviewer. */
export function applyProvenanceChange(
  before: string,
  after: string,
  current: readonly ProvenanceSegment[],
  attribution: ProvenanceAttribution,
  decisionEvents: readonly DecisionEvent[] = [],
  hunks: readonly TextChangeHunk[] = textChangeHunks(before, after),
): ProvenanceSegment[] {
  const normalizedCurrent = normalizeProvenance(current);
  const existing = coversDocument(normalizedCurrent, before.length)
    ? normalizedCurrent
    : baselineProvenance(before, {
        author: "Unknown",
        source: "baseline",
        timestamp: attribution.timestamp,
      });
  if (before === after) return existing;

  const next: ProvenanceSegment[] = [];
  let beforeCursor = 0;
  let afterCursor = 0;
  for (const hunk of hunks) {
    next.push(...copyStableRange(existing, beforeCursor, hunk.beforeFrom, afterCursor));
    if (hunk.afterTo > hunk.afterFrom) {
      next.push({ from: hunk.afterFrom, to: hunk.afterTo, ...attribution });
    }
    beforeCursor = hunk.beforeTo;
    afterCursor = hunk.afterTo;
  }
  next.push(...copyStableRange(existing, beforeCursor, before.length, afterCursor));

  let result = normalizeProvenance(next);
  for (const range of suggestionRanges(before, after, hunks, existing, decisionEvents)) {
    result = overlayAttribution(result, range.from, range.to, range.attribution);
  }
  return result;
}

/** Attributions intersecting a selected range, clipped to that exact selection. */
export function provenanceForRange(
  segments: readonly ProvenanceSegment[],
  from: number,
  to: number,
): ProvenanceSegment[] {
  if (to <= from) return [];
  return segments.flatMap((segment) => {
    const clippedFrom = Math.max(segment.from, from);
    const clippedTo = Math.min(segment.to, to);
    return clippedTo > clippedFrom
      ? [{ ...segment, from: clippedFrom, to: clippedTo }]
      : [];
  });
}
