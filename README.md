# ACM — Agent CriticMarkup

A minimal, local, single-document editor where a **human and AI agents collaborate on prose** using the [CriticMarkup](http://criticmarkup.com/) convention — with a *rendered* UI, not raw Markdown.

The single source of truth is **one CriticMarkup `.md` file on disk**. The human edits through ACM's UI; agents (Claude Code / Codex CLI / anything) edit by writing that same file. ACM live-reflects external changes and writes the human's edits back. **The file is the API** — no database, no hidden document model an agent can't read or write.

![ACM](docs/screenshot.png)

## Install & use

```bash
bun install
bun run build:embed        # build the SPA + embed it for the CLI
bun link                   # put `acm` on your PATH (~/.bun/bin/acm)

acm path/to/doc.md         # open the editor on that file (creates it if missing)
acm                        # open a new untitled doc
acm --help                 # options: --port <n>, --no-open
```

The doc is chosen **explicitly** by the argument — no env indirection that can
silently point two sessions at different copies.

**Standalone binary** (à la `bun` — a single executable, no Bun needed to run it):

```bash
bun run build:bin          # → dist/acm  (one ~56MB executable, SPA embedded)
./dist/acm path/to/doc.md
```

**Agent-review skill** — the editable copy lives in `~/.agents/skills/acm-review/`;
`~/.claude/skills/acm-review` is a symlink to it (never overwritten on reinstall):

```bash
acm skill
```

**Development** (hot-reload):

```bash
bun run dev                # Vite (:12000) + Bun server (:12001) — open http://localhost:12000
```

(The legacy `ACM_DOC=/path/to/your.md bun run start` env path still works for the
single-process prod server.)

## CriticMarkup it understands

| Syntax | Meaning | Rendered as |
| --- | --- | --- |
| `{++inserted++}` | suggested addition | green, inline ✓/✗ |
| `{--deleted--}` | suggested deletion | red strikethrough, inline ✓/✗ |
| `{~~old~>new~~}` | substitution | old struck → new green, inline ✓/✗ |
| `{==highlight==}` | highlight | yellow |
| `{>>comment<<}` | comment | right-margin bubble, connector line to its anchor |

Comments support an author prefix: `{>>@claude: needs a citation<<}` → the bubble shows the author, colored per author.

## How it works for the human

- **Suggestion mode** — every insertion/deletion/substitution has inline ✓ (accept) / ✗ (reject) controls. Accept applies the change and strips the markup *in the file*; reject reverts and strips. The nav panel offers the same controls per item.
- **Comments** — each `{>>…<<}` is a margin bubble connected to its anchor. **Resolve** removes it. **Add a comment** by selecting text and clicking *Add comment*.
- **Navigation** — the left panel lists every suggestion/comment with counts and filters (all / comments / suggestions / unresolved); click to jump.
- **Keyboard** — `Alt+↓`/`Alt+J` next · `Alt+↑`/`Alt+K` prev · `Alt+Y` accept · `Alt+N` reject (the active item).
- **Live** — when an agent rewrites the file on disk, the UI updates within ~1s without losing your scroll position.

## How it works for an agent

An agent has two equally first-class ways to participate — both end as plain text in the same `.md`:

1. **Write the file directly.** Append/insert CriticMarkup. e.g.
   ```bash
   printf '\n\nNew section. {>>@claude: is this the right place?<<}\n' >> sample-essay.md
   ```
   ACM picks it up and renders it live.

2. **Drop a comment via the HTTP endpoint** (no need to hand-write markup at a precise offset):
   ```bash
   curl -X POST localhost:12001/api/comment \
     -H 'content-type: application/json' \
     -d '{"anchor": 1280, "text": "tighten this", "author": "claude"}'
   ```
   `anchor` is a character offset; ACM inserts `{>>@claude: tighten this<<}` there using the same grammar the UI uses.

## Architecture

```
server.ts            Bun.serve — GET/PUT /api/doc, POST /api/comment, WebSocket /ws,
                     a directory watcher + a single content-hash gate (lastKnownHash)
                     that prevents the write→watch→broadcast→clobber feedback loop.
src/lib/             criticmarkup.ts — the one grammar (scan + format + accept/reject),
                     shared by the editor, the sidebar, and the server. types.ts.
src/editor/          CodeMirror 6: a @lezer/markdown CriticMarkup parser, decoration +
                     widget layers, Markdown live-preview, and a thin uncontrolled hook.
src/components/      CommentSidebar (coordsAtPos anchoring, connectors) + NavPanel.
src/client/          useDocSync — WebSocket pushes + debounced, version-checked saves.
src/App.tsx          Integration: the buffer is ground truth; local edits debounce-save,
                     remote edits rebase via a scroll-preserving ranged diff.
```

**Key invariant:** the CodeMirror plain-text buffer mirrors the file byte-for-byte. There is no separate editor document model — which is exactly what lets an agent read and write the document with no special API.

## Non-goals

One file, one window. No multi-doc/project management, no auth, no cloud, no multiplayer cursors, no export pipeline (it's already a `.md`).
