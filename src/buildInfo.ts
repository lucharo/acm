// Where this ACM build came from (#55), shown beside the version: a release built
// by the release workflow from a version tag, or a build (or source run) from a
// git checkout, with its branch, commit and whether it had uncommitted changes.

export interface BuildInfo {
  kind: "release" | "checkout";
  /** The release tag, or the checkout's branch (null when detached or unknown). */
  ref: string | null;
  commit: string | null;
  dirty: boolean;
}

export interface GitState {
  ref: string | null;
  commit: string | null;
  dirty: boolean;
}

/** The release workflow builds on a tag push in GitHub Actions; anything else is a checkout. */
export function describeBuild(env: Record<string, string | undefined>, git: GitState | null): BuildInfo {
  if (env.GITHUB_ACTIONS === "true" && env.GITHUB_REF_TYPE === "tag") {
    return { kind: "release", ref: env.GITHUB_REF_NAME ?? null, commit: env.GITHUB_SHA?.slice(0, 7) ?? null, dirty: false };
  }
  return { kind: "checkout", ref: git?.ref ?? null, commit: git?.commit ?? null, dirty: git?.dirty ?? false };
}

/** One line for people: "release v0.2.0", "local checkout, main @ 4a5b51f". */
export function formatBuild(build: BuildInfo | null): string {
  if (!build) return "source unknown";
  if (build.kind === "release") return build.ref ? `release ${build.ref}` : "release";
  const at = [build.ref, build.commit].filter(Boolean).join(" @ ");
  return `local checkout${at ? `, ${at}` : ""}${build.dirty ? ", with uncommitted changes" : ""}`;
}
