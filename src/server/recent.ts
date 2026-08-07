import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { readConfig, updateConfig } from "./config";

const FILE = "recent-documents.json";
const MAX_STORED = 20;

interface StoredRecentDocument {
  path: string;
  openedAt: string;
}

interface RecentDocumentStore {
  documents?: unknown;
}

export interface RecentDocument extends StoredRecentDocument {
  name: string;
}

function validDocuments(value: unknown): StoredRecentDocument[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is StoredRecentDocument =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as StoredRecentDocument).path === "string" &&
      typeof (entry as StoredRecentDocument).openedAt === "string",
  );
}

export async function recordRecentDocument(
  documentPath: string,
  openedAt = new Date().toISOString(),
): Promise<boolean> {
  try {
    const path = resolve(documentPath);
    await updateConfig<RecentDocumentStore>(FILE, {}, (current) => {
      const documents = validDocuments(current.documents).filter(
        (entry) => resolve(entry.path) !== path,
      );
      documents.unshift({ path, openedAt });
      return { documents: documents.slice(0, MAX_STORED) };
    });
    return true;
  } catch {
    return false;
  }
}

export async function listRecentDocuments(limit = 8): Promise<RecentDocument[]> {
  const current = await readConfig<RecentDocumentStore>(FILE, {});
  return validDocuments(current.documents)
    .map((entry) => ({ ...entry, path: resolve(entry.path) }))
    .filter((entry) => existsSync(entry.path))
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
    .slice(0, limit)
    .map((entry) => ({ ...entry, name: basename(entry.path) }));
}
