# Maintainers

How ACM is built, tested and shipped, and the rules a change must not break. Agents working in the repository also read [`CLAUDE.md`](https://github.com/lucharo/acm/blob/main/CLAUDE.md); the project's words are fixed in the glossary, [`CONTEXT.md`](https://github.com/lucharo/acm/blob/main/CONTEXT.md).

## Commands

| Command | Does |
| --- | --- |
| `bun install --frozen-lockfile` | Installs the locked dependencies |
| `bun run dev` (`just dev [doc]`) | Vite with hot reload on a random port in 12001-12499, the Bun server 500 above it; restarts either if it exits; opens a browser tab unless `ACM_NO_OPEN=1` or `BROWSER=/usr/bin/true`. With no doc it edits a gitignored copy of the seed in `.acm-data/` |
| `just prod <doc>` | Fresh build served on port 12000, the port reserved for real editing; needs a document |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test src` | Unit tests |
| `bun run build:bin` | Builds `dist/acm`, one executable with the editor and dictionaries embedded |
| `bun run check` | The release gate: typecheck, tests, `build:bin`, a smoke test of `dist/acm` from outside `node_modules`, and the setup tests |
| `just docs` / `just docs-build` | Serves this site locally / builds it with `--strict` |

ACM has no separate lint command.

## Rules a change must not break

- **The plain-text buffer is the file.** The editor's CodeMirror buffer mirrors the `.md` byte for byte; there is no second document model. Anything new must be expressible as CriticMarkup text ([ADR-0004](adr/0004-the-file-is-the-api.md)).
- **It must work in the compiled binary.** `bun build --compile` does not embed files read from `node_modules` at runtime, so such reads work from source and break in `dist/acm`. Embed through a generated, gitignored module of `import … with { type: "file" }` statements, as `scripts/gen-embedded.ts` and `scripts/gen-embedded-dicts.ts` do. Verify by running `dist/acm <verb>` from a directory with no `node_modules` above it. `CLAUDE.md` has the full rule.
- **The server decides merges.** Agent and editor writes 3-way merge on the server, which also guards the human's cursor ([ADR-0005](adr/0005-server-side-merge-authority.md)).
- **Local only.** No accounts or cloud ([ADR-0006](adr/0006-local-only-no-accounts.md)).
- **Port 12000 is for real editing.** `bun run dev` picks ports from 12001 up; tests let the OS assign one.

## Where the code lives

| Path | Holds |
| --- | --- |
| `cli.ts`, `src/cli/` | The `acm` command: invocation parsing, review verbs, spelling, Google Docs import |
| `server.ts`, `src/server/` | `Bun.serve` routes, file watching, merge, history, snapshots, launcher, instance registry |
| `src/lib/criticmarkup.ts` | The shared CriticMarkup scanner: tokens, threads, accept and reject, heal. Used by the card margin, server and CLI; the editor's own parser (`src/editor/criticMarkupParser.ts`) must agree with it |
| `src/editor/` | CodeMirror 6: the CriticMarkup parser, decorations, live Markdown preview |
| `src/components/`, `src/App.tsx` | The card margin, header, table of contents and the integration around them |
| `src/client/useDocSync.ts` | WebSocket pushes and debounced, version-checked saves |
| `skills/acm-review/SKILL.md` | The agent skill that the installer and setup install |
| `install.sh` | The `curl \| sh` installer for released binaries |
| `scripts/` | Setup, the binary build, embed generators, the check runner, docs captures |

## Shipping

- Users install with `install.sh`, which downloads a GitHub release; updating is running it again ([Getting started](getting-started.md#update)). Contributors run `bun run setup` from a clone.
- To release, bump `version` in `package.json`, then push a tag: `git tag v0.2.0 && git push origin v0.2.0`. `.github/workflows/release.yml` builds and smoke-tests the macOS arm64, macOS x64 and Linux x64 binaries on their own runners, then publishes them with the skill archive and `SHA256SUMS`. A tag with a suffix (`v0.2.0-rc.1`) publishes a prerelease, which the installer ignores unless `ACM_VERSION` names it.
- CI (`.github/workflows/ci.yml`) runs `bun run check` on Node 22.20 and the pinned Bun for every pull request and push to `main`.
- Bun is pinned exactly in `package.json` (`packageManager`), and setup refuses any other version.

## Docs

- Pages live in `docs/`, built with [Zensical](https://zensical.org) through `uvx`; the config is `zensical.toml`. `.github/workflows/docs.yml` runs a strict build on every pull request that touches them and publishes [acm.luischav.es](https://acm.luischav.es) on every push to `main`, through GitHub Pages.
- CLI output and screenshots are real. `bash scripts/docs-capture.sh` (macOS: it uses `sips`) regenerates them from `seed/docs-demo.md` on a throwaway server: CLI output into `docs/snippets/`, screenshots into `docs/assets/`. Re-run it after a change to the CLI's output or the editor's look.
- Architecture decisions are point-in-time records in `docs/adr/`; add a new one rather than rewriting an old one.

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-generated-spelling-supplement.md) | A generated spelling supplement |
| [0002](adr/0002-images-as-sibling-assets.md) | Images as sibling assets |
| [0003](adr/0003-suggest-card-envelope.md) | The SUGGEST card envelope |
| [0004](adr/0004-the-file-is-the-api.md) | The file is the API |
| [0005](adr/0005-server-side-merge-authority.md) | Server-side merge authority |
| [0006](adr/0006-local-only-no-accounts.md) | Local only, no accounts |
