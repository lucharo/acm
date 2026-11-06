import { describe, expect, test } from "bun:test";
import { parseInvocation } from "./invocation";

const agentVerbs = new Set(["threads", "reply", "import"]);
const parse = (argv: string[]) => parseInvocation(argv, (value) => !!value && agentVerbs.has(value));

describe("parseInvocation", () => {
  test("bare acm is explanatory and starts no editor", () => {
    expect(parse([])).toEqual({ kind: "overview" });
  });

  test("acm edit opens the launcher", () => {
    expect(parse(["edit"])).toEqual({ kind: "edit", open: true });
  });

  test("acm edit accepts one explicit file and edit options", () => {
    expect(parse(["edit", "essay.md", "--port", "12345", "--no-open"])).toEqual({
      kind: "edit",
      file: "essay.md",
      port: 12345,
      open: false,
    });
  });

  test("--asset-root names the folder relative images may reach", () => {
    expect(parse(["edit", "spec.md", "--asset-root", "../.."])).toEqual({
      kind: "edit",
      file: "spec.md",
      assetRoot: "../..",
      open: true,
    });
    expect(parse(["edit", "spec.md", "--asset-root"])).toEqual({
      kind: "error",
      message: "acm edit: --asset-root requires a folder",
    });
  });

  test("--allow-host may repeat", () => {
    expect(parse(["edit", "a.md", "--allow-host", "mac.ts.net", "--allow-host", "pi.ts.net"])).toEqual({
      kind: "edit",
      file: "a.md",
      allowHosts: ["mac.ts.net", "pi.ts.net"],
      open: true,
    });
    expect(parse(["edit", "--allow-host"])).toEqual({
      kind: "error",
      message: "acm edit: --allow-host requires a host name",
    });
  });

  test("a bare filename has no compatibility path", () => {
    expect(parse(["essay.md"])).toEqual({
      kind: "error",
      message: "acm: unknown command or bare document path: essay.md\nUse: acm edit essay.md",
    });
  });

  test("agent verbs keep their existing arguments", () => {
    expect(parse(["threads", "--json", "--doc", "essay.md"])).toEqual({
      kind: "agent",
      verb: "threads",
      args: ["--json", "--doc", "essay.md"],
    });
  });

  test("invalid edit options fail before starting a server", () => {
    expect(parse(["edit", "--port", "nope"])).toEqual({
      kind: "error",
      message: "acm edit: --port requires an integer from 0 to 65535",
    });
    expect(parse(["edit", "one.md", "two.md"])).toEqual({
      kind: "error",
      message: "acm edit: pass one Markdown document at a time",
    });
  });
});
