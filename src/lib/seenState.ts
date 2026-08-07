export type SeenByDocument = Record<string, string[]>;

export interface SeenDocumentState {
  keys: string[];
  source: "document" | "legacy" | "none";
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
    : null;
}

function seenMap(value: unknown): SeenByDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: SeenByDocument = {};
  for (const [path, keys] of Object.entries(value)) {
    const parsed = stringArray(keys);
    if (parsed) result[path] = parsed;
  }
  return result;
}

/** Resolve one document's seen state. Explicit slices retain identities even
 * while edits temporarily remove their comments, so undo can restore the same
 * seen state. A legacy flat array is ambiguous across documents, so it is
 * quarantined rather than silently hiding an identical comment elsewhere. */
export function seenStateForDocument(
  config: Record<string, unknown> | null,
  documentPath: string,
  _currentDocumentKeys?: ReadonlySet<string>,
): SeenDocumentState {
  const byDocument = seenMap(config?.seenByDocument);
  if (Object.prototype.hasOwnProperty.call(byDocument, documentPath)) {
    return {
      keys: [...byDocument[documentPath]],
      source: "document",
    };
  }
  const legacy = stringArray(config?.seen);
  if (legacy && legacy.length > 0) {
    return { keys: [], source: "legacy" };
  }
  return { keys: [], source: "none" };
}

export function legacySeenQuarantinePatch(
  config: Record<string, unknown> | null,
): Record<string, unknown> {
  const legacy = stringArray(config?.seen) ?? [];
  const quarantined = stringArray(config?.seenLegacyQuarantine) ?? [];
  return {
    seen: [],
    seenLegacyQuarantine: [...new Set([...quarantined, ...legacy])],
  };
}

export function seenPatchForDocument(
  documentPath: string,
  keys: readonly string[],
): Record<string, unknown> {
  return {
    seenByDocument: { [documentPath]: [...new Set(keys)] },
  };
}

/** Settings endpoints receive narrow per-document patches. Merge this nested
 * map one level deep so two open documents cannot erase each other's seen set. */
export function mergeConfigPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current, ...patch };
  if (patch.seenByDocument && typeof patch.seenByDocument === "object") {
    merged.seenByDocument = {
      ...seenMap(current.seenByDocument),
      ...seenMap(patch.seenByDocument),
    };
  }
  return merged;
}

export function seenLocalStorageKey(documentPath: string): string {
  return `acm-seen:${encodeURIComponent(documentPath)}`;
}
