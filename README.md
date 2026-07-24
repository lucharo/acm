# ACM — Agent CriticMarkup

A minimal, local, single-document editor where a **human and AI agents collaborate on prose** using the [CriticMarkup](http://criticmarkup.com/) convention — with a *rendered* UI, not raw Markdown.

The single source of truth is **one CriticMarkup `.md` file on disk**. The human edits through ACM's UI; agents (Claude Code / Codex CLI / anything) edit by writing that same file. ACM live-reflects external changes and writes the human's edits back. **The file is the API** — no database, no hidden document model an agent can't read or write.

![ACM](docs/screenshot.png)

## Install & use

From the repository root, run the one canonical setup command:

```bash
bun run setup
```

Setup requires Node 22.20 or newer for the pinned `npx skills add` command. It
verifies the pinned Bun version and Node toolchain, installs the locked dependencies, builds a
standalone `acm` binary, installs it in a user-local directory already on
`PATH` (normally `~/.local/bin`), installs the agent-review skill through the
standard `skills` CLI, and verifies both are discoverable. Re-run the same
command after pulling changes.
`just install` is a convenience alias. To choose the binary directory explicitly:

```bash
ACM_INSTALL_DIR="$HOME/.local/bin" bun run setup
```

If the managed skill was edited locally, setup stops before making changes.
`bun run setup --force` first preserves that skill directory under
`~/.agents/skill-backups/` as a timestamped backup, then refreshes it.

Then use ACM from anywhere:

```bash
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

**Import from Google Docs** — a link-accessible Google Doc can be fetched as a
DOCX export, or you can download the DOCX yourself for a private document:

```bash
acm import 'https://docs.google.com/document/d/…/edit'
acm import path/to/google-doc-export.docx
acm import path/to/google-doc-export.docx review.md
```

The generated CriticMarkup Markdown keeps prose, headings, bullet lists,
comments with their authors and best-effort anchors, plus tracked insertions
and deletions. Private Docs deliberately do not trigger a Google login flow;
download them as `.docx` and use the local-file form.

**Agent-review skill** — setup delegates path and adapter management to the
standard `skills` CLI. It installs one global universal copy and enables it for
Codex and Claude Code. To run that step independently from the repository root:

```bash
npx --yes skills@1.5.20 add . --skill acm-review --agent codex claude-code --global --yes
```

**Development** (hot-reload):

```bash
bun install --frozen-lockfile
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

One doc per window. No workspace or project management (a picker for opening a doc is fine; doc collections are not). No accounts or access levels — sharing, if it ever lands, is your own tunnel exposing your local instance (ADR-0006). No cloud and no multiplayer cursors. Import is a one-shot conversion into the local `.md`; ACM does not retain a Google connection or synchronize changes.
