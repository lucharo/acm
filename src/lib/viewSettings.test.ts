import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, loadSettings } from "./viewSettings";

const originalStorage = globalThis.localStorage;

function storageWith(value: string | null): Storage {
  const values = new Map<string, string>();
  if (value !== null) values.set("acm-settings", value);
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, next) => void values.set(key, next),
  };
}

function installStorage(value: string | null) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storageWith(value),
  });
}

afterEach(() => {
  if (originalStorage === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
  else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalStorage });
});

describe("Apply & resolve setting", () => {
  test("a fresh or older settings file defaults to non-destructive Apply", () => {
    installStorage(JSON.stringify({ theme: "dark" }));

    expect(DEFAULT_SETTINGS.applyAndResolve).toBe(false);
    expect(loadSettings().applyAndResolve).toBe(false);
  });

  test("an enabled setting survives a cold load", () => {
    installStorage(JSON.stringify({ applyAndResolve: true }));

    expect(loadSettings().applyAndResolve).toBe(true);
  });

  test("disabling the setting survives a cold load", () => {
    installStorage(JSON.stringify({ applyAndResolve: false }));

    expect(loadSettings().applyAndResolve).toBe(false);
  });
});

describe("comment edge setting", () => {
  test("older settings default to automatic rail visibility", () => {
    installStorage(JSON.stringify({ theme: "dark" }));

    expect(DEFAULT_SETTINGS.commentRail).toBe("auto");
    expect(loadSettings().commentRail).toBe("auto");
  });

  test("explicit show and hide choices survive cold loads", () => {
    installStorage(JSON.stringify({ commentRail: "show" }));
    expect(loadSettings().commentRail).toBe("show");

    installStorage(JSON.stringify({ commentRail: "hide" }));
    expect(loadSettings().commentRail).toBe("hide");
  });
});

describe("rich preview setting", () => {
  test("older settings default to rich preview", () => {
    installStorage(JSON.stringify({ theme: "light" }));

    expect(DEFAULT_SETTINGS.richPreview).toBe(true);
    expect(loadSettings().richPreview).toBe(true);
  });

  test("raw source mode survives a cold load and can be re-enabled", () => {
    installStorage(JSON.stringify({ richPreview: false }));
    expect(loadSettings().richPreview).toBe(false);

    installStorage(JSON.stringify({ richPreview: true }));
    expect(loadSettings().richPreview).toBe(true);
  });
});

describe("PDF settings", () => {
  test("older settings use the simple print style with alternating book pages enabled", () => {
    installStorage(JSON.stringify({ theme: "dark" }));

    expect(loadSettings().printStyle).toBe("simple");
    expect(loadSettings().printAlternateSides).toBe(true);
  });

  test("Tufte style and fixed-right references survive a cold load", () => {
    installStorage(JSON.stringify({ printStyle: "tufte", printAlternateSides: false }));

    expect(loadSettings().printStyle).toBe("tufte");
    expect(loadSettings().printAlternateSides).toBe(false);
  });
});
