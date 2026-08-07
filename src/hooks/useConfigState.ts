// ── Persisted review state: view settings + the "seen" set ────────────────────
// Both follow the same shape: localStorage is the INSTANT cache (no fetch
// flash), ~/.config/acm/settings.json (via the server) is the cross-instance
// truth. Each writer PUTs only its own key (settings | seenByDocument slice) and the server
// merges, so they never clobber each other; hydration gates the first PUT so
// the server isn't overwritten before it's been read.

import { useCallback, useEffect, useRef, useState } from "react";
import { FONT_STACKS, loadSettings } from "../lib/viewSettings";
import type { ViewSettings } from "../lib/viewSettings";
import {
  legacySeenQuarantinePatch,
  seenLocalStorageKey,
  seenPatchForDocument,
  seenStateForDocument,
} from "../lib/seenState";

export async function fetchConfig(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch("/api/settings");
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
export async function putConfig(patch: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function reconcileViewSettings(
  local: ViewSettings,
  server: Partial<ViewSettings> | null,
  localDirty: boolean,
): ViewSettings {
  if (localDirty) return local;
  return server ? { ...local, ...server } : local;
}

const SETTINGS_DIRTY_KEY = "acm-settings-dirty";
const LEGACY_SEEN_KEY = "acm-seen";
const LEGACY_SEEN_QUARANTINE_KEY = "acm-seen:legacy-quarantine";

interface SettingsPersistenceDependencies {
  write: (patch: Record<string, unknown>) => Promise<boolean>;
  storage: Pick<Storage, "setItem" | "removeItem">;
  onSaveError: (failed: boolean) => void;
}

/** Keep only the newest local settings revision authoritative. A response from
 * an older request must not clear the dirty marker or overwrite the visible
 * error state after the user has made another choice. */
export function createSettingsPersistence({
  write,
  storage,
  onSaveError,
}: SettingsPersistenceDependencies) {
  let revision = 0;
  let writeTail: Promise<void> = Promise.resolve();
  const markChanged = () => {
    revision += 1;
    storage.setItem(SETTINGS_DIRTY_KEY, "1");
    return revision;
  };
  return {
    markChanged,
    async persist(next: ViewSettings): Promise<boolean> {
      const requestRevision = markChanged();
      const save = writeTail.then(() => write({ settings: next }));
      writeTail = save.then(
        () => undefined,
        () => undefined,
      );
      const saved = await save;
      if (requestRevision === revision) {
        if (saved) storage.removeItem(SETTINGS_DIRTY_KEY);
        onSaveError(!saved);
      }
      return saved;
    },
  };
}

// ── "Seen" comment tracking (declutter between review rounds) ──────────────────
// "Seen" is a lightweight, NON-destructive state (unlike Resolve, which strips the
// markup from the file). Comment identities remain content-based so positional
// edits do not reset them, while the containing cache/config slice is keyed by
// document path so identical comments in different files never share state.
export function loadSeen(
  documentPath: string,
  currentDocumentKeys: ReadonlySet<string>,
  storage: Pick<Storage, "getItem"> = localStorage,
): { seen: Set<string>; legacy: boolean } {
  try {
    const scoped = storage.getItem(seenLocalStorageKey(documentPath));
    const legacy = scoped === null ? storage.getItem("acm-seen") : null;
    const value = JSON.parse(scoped ?? legacy ?? "[]") as unknown;
    const parsed = Array.isArray(value)
      ? [...new Set(value.filter((key): key is string => typeof key === "string"))]
      : [];
    const keys = scoped === null ? [] : parsed;
    return { seen: new Set(keys), legacy: scoped === null && legacy !== null };
  } catch {
    return { seen: new Set(), legacy: false };
  }
}

export function quarantineLegacySeenStorage(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage,
): boolean {
  try {
    const legacy = storage.getItem(LEGACY_SEEN_KEY);
    if (legacy === null) return true;
    storage.setItem(LEGACY_SEEN_QUARANTINE_KEY, legacy);
    storage.removeItem(LEGACY_SEEN_KEY);
    return true;
  } catch {
    return false;
  }
}

// ── Personal spelling dictionary (words the user added) ────────────────────────
// Same localStorage-cache + server-truth shape as the seen set. Stored lowercased
// and de-duplicated; the spellchecker (editor/spellcheck.ts) mirrors it into the
// live engine so both flagging and suggestions honour it.
function loadDictionary(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem("acm-dictionary") ?? "[]");
    return Array.isArray(raw) ? (raw as string[]) : [];
  } catch {
    return [];
  }
}

/** View settings: localStorage-seeded state + theme/font application to the
 *  document root + server reconciliation. Lives at the App level so theme/font
 *  apply to the loading screen too. */
export function useViewSettings() {
  // View settings live here so theme/font apply to the loading screen too. Initialised
  // from localStorage (instant, no flash) and reconciled with the server file below.
  const [settings, setSettings] = useState<ViewSettings>(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [settingsSaveError, setSettingsSaveError] = useState(false);
  const settingsPersistence = useRef<ReturnType<typeof createSettingsPersistence> | null>(null);
  if (!settingsPersistence.current) {
    settingsPersistence.current = createSettingsPersistence({
      write: putConfig,
      storage: localStorage,
      onSaveError: setSettingsSaveError,
    });
  }
  const persistSettings = useCallback(
    (next: ViewSettings) => settingsPersistence.current!.persist(next),
    [],
  );
  useEffect(() => {
    const root = document.documentElement;
    // "system" resolves to the OS preference and TRACKS it live; the CSS only
    // knows data-theme="light|dark", so resolution happens here.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      root.dataset.theme =
        settings.theme === "system" ? (mq.matches ? "dark" : "light") : settings.theme;
    };
    apply();
    root.style.setProperty("--editor-font", FONT_STACKS[settings.font]);
    localStorage.setItem("acm-settings", JSON.stringify(settings));
    if (settings.theme === "system") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [settings]);
  const onChangeSettings = useCallback(
    (patch: Partial<ViewSettings>) => {
      settingsPersistence.current!.markChanged();
      setSettings((s) => ({ ...s, ...patch }));
    },
    [],
  );
  // On mount: adopt the server's settings (cross-instance truth); if it has none,
  // migrate this browser's localStorage settings up to the server. Gate the sync
  // PUT until after this so we don't clobber the server before reading it.
  const settingsHydrated = useRef(false);
  const skipNextSettingsSync = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void fetchConfig().then(async (cfg) => {
      if (cancelled) return;
      const local = loadSettings();
      const localDirty = localStorage.getItem(SETTINGS_DIRTY_KEY) === "1";
      const serverSettings =
        cfg && cfg.settings ? (cfg.settings as Partial<ViewSettings>) : null;
      const reconciled = reconcileViewSettings(local, serverSettings, localDirty);
      settingsHydrated.current = true;
      if (!localDirty && serverSettings) {
        skipNextSettingsSync.current = true;
        setSettings(reconciled);
      } else {
        // A failed prior write (or first run) keeps the local choice authoritative
        // across a cold start and retries it against the server truth.
        await persistSettings(reconciled);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!settingsHydrated.current) return;
    if (skipNextSettingsSync.current) {
      skipNextSettingsSync.current = false;
      return;
    }
    const t = setTimeout(() => void persistSettings(settings), 300);
    return () => clearTimeout(t);
  }, [settings, persistSettings]);
  const retrySettings = useCallback(() => {
    void persistSettings(settingsRef.current);
  }, [persistSettings]);
  return { settings, onChangeSettings, settingsSaveError, retrySettings };
}

/** The per-document "seen" set: localStorage-seeded, server-reconciled. */
export function useSeenState(
  documentPath: string,
  currentDocumentKeys: ReadonlySet<string>,
) {
  const documentKeysRef = useRef(currentDocumentKeys);
  documentKeysRef.current = currentDocumentKeys;
  // cache; ~/.config/acm/settings.json is the cross-instance truth (synced below).
  const [seen, setSeen] = useState<Set<string>>(
    () => loadSeen(documentPath, currentDocumentKeys).seen,
  );
  useEffect(() => {
    localStorage.setItem(seenLocalStorageKey(documentPath), JSON.stringify([...seen]));
  }, [documentPath, seen]);
  // On mount: adopt this document's server slice, or migrate the legacy flat
  // state / scoped local cache into one explicit slice.
  const seenHydrated = useRef(false);
  const skipNextSeenSync = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void fetchConfig().then((cfg) => {
      if (cancelled) return;
      const server = seenStateForDocument(
        cfg,
        documentPath,
        documentKeysRef.current,
      );
      const local = loadSeen(documentPath, documentKeysRef.current);
      if (local.legacy) quarantineLegacySeenStorage();
      const next = server.source === "none" ? local.seen : new Set(server.keys);
      seenHydrated.current = true;
      skipNextSeenSync.current = true;
      setSeen(next);
      if (server.source !== "document") {
        const patch = seenPatchForDocument(documentPath, [...next]);
        if (server.source === "legacy") {
          Object.assign(patch, legacySeenQuarantinePatch(cfg));
        }
        void putConfig(patch);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [documentPath]);
  useEffect(() => {
    if (!seenHydrated.current) return;
    if (skipNextSeenSync.current) {
      skipNextSeenSync.current = false;
      return;
    }
    const t = setTimeout(
      () => putConfig(seenPatchForDocument(documentPath, [...seen])),
      300,
    );
    return () => clearTimeout(t);
  }, [documentPath, seen]);
  return { seen, setSeen };
}

/** The personal spelling dictionary: localStorage-seeded, server-reconciled, with
 *  add/remove helpers. Words are normalised to lowercase + deduped on write. */
export function useDictionary() {
  const [dictionary, setDictionary] = useState<string[]>(loadDictionary);
  useEffect(() => {
    localStorage.setItem("acm-dictionary", JSON.stringify(dictionary));
  }, [dictionary]);
  // On mount: adopt the server's list, or migrate localStorage up on first run.
  const hydrated = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void fetchConfig().then((cfg) => {
      if (cancelled) return;
      if (cfg && Array.isArray(cfg.dictionary)) setDictionary(cfg.dictionary as string[]);
      else putConfig({ dictionary: loadDictionary() });
      hydrated.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // Re-read on window focus: `acm spell add` PUTs a merged list to /api/settings
  // while this state is stale — without a re-read, the NEXT GUI add would PUT the
  // stale list back and silently drop the CLI-added words. Focus is the natural
  // moment (terminal → click back into the editor). UNION-merge server+local (not
  // wholesale adoption): a local add whose debounced PUT hasn't landed — browsers
  // throttle background-tab timers, so blur→CLI→refocus can beat it — survives, in
  // EVERY interleaving, and the debounced PUT then persists the union. Trade-off:
  // a GUI removal in its own pre-PUT window can resurrect; removals are rare and
  // visibly correctable, lost additions are silent. Server-side removals still
  // propagate on reload (which adopts wholesale). JSON-equal skip keeps idle focus
  // cycles from churning PUTs.
  const dictRef = useRef(dictionary);
  dictRef.current = dictionary;
  useEffect(() => {
    const sync = () => {
      if (!hydrated.current) return;
      void fetchConfig().then((cfg) => {
        if (!cfg || !Array.isArray(cfg.dictionary)) return;
        const local = dictRef.current;
        const merged = [...new Set([...local, ...(cfg.dictionary as string[])])].sort();
        if (JSON.stringify(merged) !== JSON.stringify(local)) setDictionary(merged);
      });
    };
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);
  useEffect(() => {
    if (!hydrated.current) return;
    const t = setTimeout(() => putConfig({ dictionary }), 300);
    return () => clearTimeout(t);
  }, [dictionary]);

  const addWord = useCallback((word: string) => {
    const w = word.trim().toLowerCase();
    if (!w) return;
    setDictionary((list) => (list.includes(w) ? list : [...list, w].sort()));
  }, []);
  const removeWord = useCallback((word: string) => {
    const w = word.toLowerCase();
    setDictionary((list) => list.filter((x) => x !== w));
  }, []);

  return { dictionary, addWord, removeWord };
}
