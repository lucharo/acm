// The installed ACM version, read from package.json at build time. Vite inlines the
// one field into the editor bundle and `bun build --compile` into the binary, so the
// editor and `acm --version` always report the build they belong to.
import { version } from "../package.json";

export const ACM_VERSION: string = version;
