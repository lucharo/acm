# ACM — project conventions

## Everything must work in the compiled standalone binary

Features must work in the compiled binary (`bun run build:bin` → `dist/acm`), not just
`bun cli.ts` source mode. `bun build --compile` does **not** embed runtime
filesystem reads — e.g. `readFileSync`/`Bun.file` on a path resolved out of
`node_modules` at runtime — so anything that reads its data that way works from source
but silently breaks in `dist/acm` (no `node_modules` beside the executable).

Use the established embed pattern instead: a build script generates a **gitignored**
module of `import … with { type: "file" }` statements (Bun embeds those into the
binary; `readFileSync`/`Bun.file` read the embedded path in both modes), dynamic-imported
from `cli.ts` — which sits **outside** the `tsconfig.json` `include`, so the generated
module's absence in plain source mode never breaks typecheck. See:

- `scripts/gen-embedded.ts` → `src/server/embedded.generated.ts` (the SPA assets)
- `scripts/gen-embedded-dicts.ts` → `src/cli/dicts.generated.ts` (the Hunspell dicts for `acm spell`)

Both run in `build:embed` (which `build:bin` depends on). **Verify** a new embed by
running `dist/acm <verb>` from a directory with no `node_modules` anywhere up the tree.

## NUL bytes (commentKey)

commentKey joins author+body with a NUL separator (author+body only — no anchor
hash), written in source as the \u0000 escape. Typing that escape in a
tool call inserts a RAW NUL byte (the file then reads as binary; Bash rejects the
command). Author NUL-bearing content via python3 (\x00 in single-quoted
script source). Repair a corrupted file by substituting the raw NUL back to the
escape text, e.g. `perl -0pi -e 's/\x00/\\u0000/g' <file>`.
