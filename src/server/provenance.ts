import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

import type { DecisionEvent } from "../lib/decision";
import { textChangeHunks, type TextChangeHunk } from "../lib/merge";
import {
  PROVENANCE_SOURCES,
  applyProvenanceChange,
  baselineProvenance,
  provenanceForRange,
  type ProvenanceAttribution,
  type ProvenanceSegment,
} from "../lib/provenance";
import { withFileUpdateLock } from "./fileLock";
import { selfIgnoreAcmDir } from "./history";

export interface ProvenanceWriteEvent extends ProvenanceAttribution {
  id: string;
  changes: TextChangeHunk[];
  decisionIds: string[];
}

export interface ProvenanceDocument {
  version: 1;
  contentLength: number;
  contentHash: string;
  updatedAt: string;
  segments: ProvenanceSegment[];
  events: ProvenanceWriteEvent[];
}

export function provenancePath(docPath: string): string {
  return join(dirname(docPath), ".acm", "provenance", `${basename(docPath)}.json`);
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function baselineDocument(content: string): ProvenanceDocument {
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    contentLength: content.length,
    contentHash: contentHash(content),
    updatedAt: timestamp,
    segments: baselineProvenance(content, {
      author: "Unknown",
      source: "baseline",
      timestamp,
    }),
    events: [],
  };
}

function validAttribution(value: Partial<ProvenanceAttribution>): boolean {
  return typeof value.author === "string" &&
    value.author.trim().length > 0 &&
    typeof value.source === "string" &&
    (PROVENANCE_SOURCES as readonly string[]).includes(value.source) &&
    typeof value.timestamp === "string" &&
    Number.isFinite(Date.parse(value.timestamp)) &&
    (value.reviewedBy === undefined || typeof value.reviewedBy === "string") &&
    (value.decisionId === undefined || typeof value.decisionId === "string") &&
    (value.operation === undefined || typeof value.operation === "string");
}

function validSegments(value: unknown, contentLength: number): value is ProvenanceSegment[] {
  if (!Array.isArray(value)) return false;
  if (contentLength === 0) return value.length === 0;
  let cursor = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const segment = item as Partial<ProvenanceSegment>;
    if (
      segment.from !== cursor ||
      typeof segment.to !== "number" ||
      !Number.isInteger(segment.to) ||
      segment.to <= cursor ||
      segment.to > contentLength ||
      !validAttribution(segment)
    ) {
      return false;
    }
    cursor = segment.to;
  }
  return cursor === contentLength;
}

function validEvents(value: unknown): value is ProvenanceWriteEvent[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const event = item as Partial<ProvenanceWriteEvent>;
    return typeof event.id === "string" &&
      event.id.length > 0 &&
      validAttribution(event) &&
      Array.isArray(event.decisionIds) &&
      event.decisionIds.every((id) => typeof id === "string") &&
      Array.isArray(event.changes) &&
      event.changes.every((change) =>
        change &&
        Number.isInteger(change.beforeFrom) &&
        Number.isInteger(change.beforeTo) &&
        Number.isInteger(change.afterFrom) &&
        Number.isInteger(change.afterTo)
      );
  });
}

function parseDocument(value: unknown, content: string): ProvenanceDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const document = value as Partial<ProvenanceDocument>;
  if (
    document.version !== 1 ||
    document.contentLength !== content.length ||
    document.contentHash !== contentHash(content) ||
    typeof document.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(document.updatedAt)) ||
    !validSegments(document.segments, content.length) ||
    !validEvents(document.events)
  ) {
    return null;
  }
  return document as ProvenanceDocument;
}

export async function readDocumentProvenance(
  docPath: string,
  content: string,
): Promise<ProvenanceDocument> {
  try {
    const parsed = JSON.parse(await readFile(provenancePath(docPath), "utf8")) as unknown;
    return parseDocument(parsed, content) ?? baselineDocument(content);
  } catch {
    return baselineDocument(content);
  }
}

async function writeDocumentProvenance(docPath: string, document: ProvenanceDocument): Promise<void> {
  const path = provenancePath(docPath);
  const acmDir = join(dirname(docPath), ".acm");
  await mkdir(dirname(path), { recursive: true });
  selfIgnoreAcmDir(acmDir);
  const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    try {
      await unlink(temporary);
    } catch {
      // The successful rename already removed the temporary path.
    }
  }
}

export async function recordProvenanceWrite(
  docPath: string,
  before: string,
  after: string,
  attribution: ProvenanceAttribution,
  decisionEvents: readonly DecisionEvent[] = [],
): Promise<ProvenanceDocument> {
  if (before === after) return readDocumentProvenance(docPath, after);
  const path = provenancePath(docPath);
  return withFileUpdateLock(`${path}.lock`, `provenance for ${docPath}`, async () => {
    const current = await readDocumentProvenance(docPath, before);
    const updatedAt = attribution.timestamp;
    const changes = textChangeHunks(before, after);
    const event: ProvenanceWriteEvent = {
      id: crypto.randomUUID(),
      ...attribution,
      changes,
      decisionIds: decisionEvents.map((decision) => decision.id),
    };
    const document: ProvenanceDocument = {
      version: 1,
      contentLength: after.length,
      contentHash: contentHash(after),
      updatedAt,
      segments: applyProvenanceChange(
        before,
        after,
        current.segments,
        attribution,
        decisionEvents,
        changes,
      ),
      events: [...current.events, event],
    };
    await writeDocumentProvenance(docPath, document);
    return document;
  });
}

export async function readDocumentProvenanceRange(
  docPath: string,
  content: string,
  from: number,
  to: number,
): Promise<Pick<ProvenanceDocument, "updatedAt" | "contentLength"> & { segments: ProvenanceSegment[] }> {
  const document = await readDocumentProvenance(docPath, content);
  return {
    updatedAt: document.updatedAt,
    contentLength: document.contentLength,
    segments: provenanceForRange(document.segments, from, to),
  };
}
