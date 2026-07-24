# ACM tasks. PORT CONVENTION:
#   :12000        = PRODUCTION — the instance actually editing your doc (`just prod`).
#   12001–12499   = DEVELOPMENT — `just dev` picks a RANDOM one each run, so a
#                   throwaway dev server never collides with prod on :12000.
# Both `dev` and `prod` take an optional doc path (defaults to the Sample seed):
#   just dev ~/notes.md      just prod ~/notes.md

# List recipes
default:
    @just --list

# Live dev server (Vite + HMR) on a random port in 12001–12499; opens the browser.
# No doc → a gitignored working copy of the seed (.acm-data/), so dev never
# dirties the committed fixture. Pass a path to serve a specific doc.
dev doc="":
    ACM_DOC="{{doc}}" bun run scripts/dev.ts

# Production: FRESH build, served on :12000 (never the stale prebuilt dist). The real editor.
prod doc="seed/sample-essay.md":
    bun run build
    ACM_PORT=12000 ACM_DOC="{{doc}}" bun run start

# Build the SPA into ./dist
build:
    bun run build

# Full release gate: types, all tests, compiled binary, and a no-node_modules smoke.
check:
    bun run check

test:
    bun run test

typecheck:
    bun run typecheck

# Compile the standalone `acm` binary
bin:
    bun run build:bin

# Convenience alias for the canonical clean-machine setup flow.
install:
    bun run setup
