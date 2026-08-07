import { afterEach, describe, expect, test } from "bun:test";

import { DEFAULT_SETTINGS } from "../lib/viewSettings";
import {
  createSettingsPersistence,
  loadSeen,
  putConfig,
  quarantineLegacySeenStorage,
  reconcileViewSettings,
} from "./useConfigState";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("settings persistence", () => {
  test("a scoped seen cache survives removal while unscoped legacy input stays unseen", () => {
    const restored = "maya\u0000Restored by undo";
    const current = "maya\u0000Current";
    const other = "maya\u0000Other document";

    expect(
      loadSeen("/docs/first.md", new Set(), {
        getItem: (key) =>
          key === "acm-seen:%2Fdocs%2Ffirst.md" ? JSON.stringify([restored]) : null,
      }).seen,
    ).toEqual(new Set([restored]));
    expect(
      loadSeen("/docs/first.md", new Set([current]), {
        getItem: (key) =>
          key === "acm-seen" ? JSON.stringify([current, other]) : null,
      }),
    ).toEqual({ seen: new Set(), legacy: true });
  });

  test("local legacy seen state is preserved under an inspectable quarantine key", () => {
    const values = new Map([["acm-seen", JSON.stringify(["maya\u0000Legacy"])]]);

    expect(
      quarantineLegacySeenStorage({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key),
      }),
    ).toBe(true);
    expect(Object.fromEntries(values)).toEqual({
      "acm-seen:legacy-quarantine": JSON.stringify(["maya\u0000Legacy"]),
    });
  });

  test("a failed settings PUT is reported to its caller", async () => {
    globalThis.fetch = (async () =>
      new Response("no", { status: 500 })) as unknown as typeof fetch;

    expect(await putConfig({ settings: { applyAndResolve: true } })).toBe(false);
  });

  test("a dirty local setting wins on cold-start reconciliation", () => {
    const local = { ...DEFAULT_SETTINGS, applyAndResolve: true };
    const server = { applyAndResolve: false };

    expect(reconcileViewSettings(local, server, true).applyAndResolve).toBe(true);
    expect(reconcileViewSettings(local, server, false).applyAndResolve).toBe(false);
  });

  test("an older save cannot clear a newer unsaved local choice", async () => {
    let dirty: string | undefined;
    const pending: Array<(saved: boolean) => void> = [];
    const saveErrors: boolean[] = [];
    const persistence = createSettingsPersistence({
      write: () => new Promise<boolean>((resolve) => pending.push(resolve)),
      storage: {
        setItem: (_key, value) => {
          dirty = value;
        },
        removeItem: () => {
          dirty = undefined;
        },
      },
      onSaveError: (failed) => saveErrors.push(failed),
    });

    const olderSave = persistence.persist({ ...DEFAULT_SETTINGS, applyAndResolve: false });
    persistence.markChanged();
    await Promise.resolve();
    pending[0](true);
    await olderSave;

    expect(dirty).toBe("1");
    expect(saveErrors).toEqual([]);

    const latestSave = persistence.persist({ ...DEFAULT_SETTINGS, applyAndResolve: true });
    await Promise.resolve();
    pending[1](true);
    await latestSave;

    expect(dirty).toBeUndefined();
    expect(saveErrors).toEqual([false]);
  });

  test("settings writes are serialized so an older request cannot land last", async () => {
    let dirty: string | undefined;
    let serverApplyAndResolve = false;
    const pending: Array<{ value: boolean; complete: (saved: boolean) => void }> = [];
    const saveErrors: boolean[] = [];
    const persistence = createSettingsPersistence({
      write: (patch) =>
        new Promise<boolean>((resolve) => {
          const value = (patch.settings as typeof DEFAULT_SETTINGS).applyAndResolve;
          pending.push({
            value,
            complete: (saved) => {
              serverApplyAndResolve = value;
              resolve(saved);
            },
          });
        }),
      storage: {
        setItem: (_key, value) => {
          dirty = value;
        },
        removeItem: () => {
          dirty = undefined;
        },
      },
      onSaveError: (failed) => saveErrors.push(failed),
    });

    const olderSave = persistence.persist({ ...DEFAULT_SETTINGS, applyAndResolve: false });
    const latestSave = persistence.persist({ ...DEFAULT_SETTINGS, applyAndResolve: true });
    await Promise.resolve();

    expect(pending.map(({ value }) => value)).toEqual([false]);

    pending[0].complete(true);
    await olderSave;
    await Promise.resolve();
    expect(pending.map(({ value }) => value)).toEqual([false, true]);

    pending[1].complete(true);
    await latestSave;

    expect(dirty).toBeUndefined();
    expect(serverApplyAndResolve).toBe(true);
    expect(saveErrors).toEqual([false]);
  });
});
