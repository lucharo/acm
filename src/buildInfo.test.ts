import { describe, expect, test } from "bun:test";
import { describeBuild, formatBuild } from "./buildInfo";

const git = { ref: "pi/feature", commit: "abc1234", dirty: false };

describe("where a build came from (#55)", () => {
  test("a tag build in GitHub Actions is a release; anything else is a checkout", () => {
    const release = { GITHUB_ACTIONS: "true", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.3.0", GITHUB_SHA: "abc1234def" };
    const branchCi = { GITHUB_ACTIONS: "true", GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" };

    expect([describeBuild(release, git), describeBuild(branchCi, git), describeBuild({}, git), describeBuild({}, null)]).toEqual([
      { kind: "release", ref: "v0.3.0", commit: "abc1234", dirty: false },
      { kind: "checkout", ref: "pi/feature", commit: "abc1234", dirty: false },
      { kind: "checkout", ref: "pi/feature", commit: "abc1234", dirty: false },
      { kind: "checkout", ref: null, commit: null, dirty: false },
    ]);
  });

  test("reads as one plain line", () => {
    expect([
      formatBuild({ kind: "release", ref: "v0.3.0", commit: "abc1234", dirty: false }),
      formatBuild({ kind: "checkout", ref: "main", commit: "abc1234", dirty: false }),
      formatBuild({ kind: "checkout", ref: null, commit: "abc1234", dirty: true }),
      formatBuild(null),
    ]).toEqual([
      "release v0.3.0",
      "local checkout, main @ abc1234",
      "local checkout, abc1234, with uncommitted changes",
      "source unknown",
    ]);
  });
});
