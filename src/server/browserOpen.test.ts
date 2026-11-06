import { describe, expect, test } from "bun:test";
import { browserOpenCommand } from "./browserOpen";

const URL = "http://localhost:12001";

describe("browserOpenCommand", () => {
  test("ACM_NO_OPEN=1 opens nothing", () => {
    expect(browserOpenCommand(URL, { ACM_NO_OPEN: "1" }, "darwin")).toBeNull();
  });

  test("ACM_NO_OPEN=0 does not switch opening off", () => {
    expect(browserOpenCommand(URL, { ACM_NO_OPEN: "0" }, "darwin")).toEqual(["open", URL]);
  });

  test("a set $BROWSER is the opener, so BROWSER=/usr/bin/true opens no tab", () => {
    expect(browserOpenCommand(URL, { BROWSER: "/usr/bin/true" }, "darwin")).toEqual(["/usr/bin/true", URL]);
  });

  test("falls back to the platform opener", () => {
    expect(browserOpenCommand(URL, {}, "darwin")).toEqual(["open", URL]);
    expect(browserOpenCommand(URL, {}, "linux")).toEqual(["xdg-open", URL]);
    expect(browserOpenCommand(URL, {}, "win32")).toEqual(["cmd", "/c", "start", "", URL]);
  });
});
