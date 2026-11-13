// The installed ACM version, read from package.json at build time. Vite inlines the
// one field into the editor bundle and `bun build --compile` into the binary, so the
// editor and `acm --version` always report the build they belong to.
import { version } from "../package.json";
import type { BuildInfo } from "./buildInfo";

export const ACM_VERSION: string = version;

// Where the build came from (#55), defined by vite.config.ts for the editor and by
// scripts/build-bin.ts for the binary; absent when running from source.
declare const __ACM_BUILD__: BuildInfo | undefined;
export const ACM_BUILD: BuildInfo | null = typeof __ACM_BUILD__ !== "undefined" ? __ACM_BUILD__ : null;
