// ── Persisted review state: view settings + the "seen" set ────────────────────
// Both follow the same shape: localStorage is the INSTANT cache (no fetch
// flash), ~/.config/acm/settings.json (via the server) is the cross-instance
// truth. Each writer PUTs only its own key (settings | seen) and the server
// merges, so they never clobber each other; hydration gates the first PUT so
// the server isn't overwritten before it's been read.

import { useCallback, useEffect, useRef, useState } from "react";
import { FONT_STACKS, loadSettings } from "../lib/viewSettings";
import type { ViewSettings } from "../lib/viewSettings";

export async function fetchConfig(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch("/api/settings");
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
function putConfig(patch: Record<string, unknown>): void {
  void fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => {});
}


// ── "Seen" comment tracking (declutter between review rounds) ──────────────────
// "Seen" is a lightweight, NON-destructive state (unlike Resolve, which strips the
// markup from the file). It lives client-side in localStorage, keyed by comment
// CONTENT (author+body) so it survives the positional-id shifts that edits cause —
// the file is never touched. The key lives in lib/criticmarkup so the CLI
// (`acm threads`) computes the same identity; re-exported here for the GUI.
export { commentKey } from "../lib/criticmarkup";
function loadSeen(): Set<string> {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem("acm-seen") ?? "[]"));
  } catch {
    return new Set();
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
    (patch: Partial<ViewSettings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );
  // On mount: adopt the server's settings (cross-instance truth); if it has none,
  // migrate this browser's localStorage settings up to the server. Gate the sync
  // PUT until after this so we don't clobber the server before reading it.
  const settingsHydrated = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void fetchConfig().then((cfg) => {
      if (cancelled) return;
      if (cfg && cfg.settings) setSettings((s) => ({ ...s, ...(cfg.settings as Partial<ViewSettings>) }));
      else putConfig({ settings: loadSettings() }); // first run → migrate
      settingsHydrated.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!settingsHydrated.current) return;
    const t = setTimeout(() => putConfig({ settings }), 300);
    return () => clearTimeout(t);
  }, [settings]);
  return { settings, onChangeSettings };
}

/** The "seen" set: localStorage-seeded, server-reconciled. */
export function useSeenState() {
  // cache; ~/.config/acm/settings.json is the cross-instance truth (synced below).
  const [seen, setSeen] = useState<Set<string>>(loadSeen);
  useEffect(() => {
    localStorage.setItem("acm-seen", JSON.stringify([...seen]));
  }, [seen]);
  // On mount: adopt the server's seen set, or migrate localStorage up on first run.
  const seenHydrated = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void fetchConfig().then((cfg) => {
      if (cancelled) return;
      if (cfg && Array.isArray(cfg.seen)) setSeen(new Set(cfg.seen as string[]));
      else putConfig({ seen: [...loadSeen()] });
      seenHydrated.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!seenHydrated.current) return;
    const t = setTimeout(() => putConfig({ seen: [...seen] }), 300);
    return () => clearTimeout(t);
  }, [seen]);
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
