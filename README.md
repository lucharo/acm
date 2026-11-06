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

Setup atomically replaces the installed executable. It does not restart or hot-reload an
ACM server that is already running; restart that server to use the new version.

`just install` is a convenience alias. To choose the binary directory explicitly:

```bash
ACM_INSTALL_DIR="$HOME/.local/bin" bun run setup
```

If the managed skill was edited locally, setup stops before making changes.
`bun run setup --force` first preserves that skill directory under
`~/.agents/skill-backups/` as a timestamped backup, then refreshes it.

Then use ACM from anywhere:

```bash
acm                        # explain ACM and list the main commands
acm edit                   # New / Open / Recent Documents launcher
acm edit path/to/doc.md    # open that file, creating it if missing
acm --help                 # every command and option
```

The old `acm path/to/doc.md` spelling is deliberately rejected; use
`acm edit path/to/doc.md` so opening a document is always explicit.

The launcher creates nothing until you confirm a Markdown filename. Each editor
process/window still owns exactly one document; the lightweight launcher adds
New, Open and Recent Documents without turning ACM into a workspace or file
browser. Editor settings are global and apply to every ACM document. Concurrent
preference changes across tabs are whole-settings last-writer-wins; document text
and decision history are unaffected.

**Standalone binary** (à la `bun` — a single executable, no Bun needed to run it):

```bash
bun run build:bin          # → dist/acm  (one ~56MB executable, SPA embedded)
./dist/acm edit path/to/doc.md
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
bun run dev                # Vite (random :12001–12499) + Bun server; prints and opens the URL
```

If either process exits, dev restarts it. `ACM_NO_OPEN=1` (or `BROWSER=/usr/bin/true`)
skips opening the browser, for agents and headless runs; `acm edit` honours both too.

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

- **Suggestion mode** — every insertion/deletion/substitution has inline ✓ (accept) / ✗ (reject) controls. Accept applies the change and strips the markup *in the file*; reject reverts and strips.
- **Comments** — each `{>>…<<}` is a margin bubble connected to its anchor. **Resolve** removes it. Select text to add a comment or suggestion; existing comments and text-bearing suggestions can be edited in place.
- **Navigation** — the top-left table-of-contents button jumps between headings. Review cards stay beside the prose on desktop and in a bottom sheet on narrow screens.
- **Keyboard** — `Cmd+Option+M` / `Ctrl+Alt+M` comments on selected text · `Cmd+Option+S` / `Ctrl+Alt+S` suggests a replacement · `Alt+↓`/`Alt+J` next · `Alt+↑`/`Alt+K` prev · `Alt+Y` accept · `Alt+N` reject (the active item).
- **Live** — when an agent rewrites the file on disk, the UI updates within ~1s without losing your scroll position.

## FAQ

### What do the header icons do?

The left side holds document controls: table of contents, then rich/raw Markdown.
The right side holds review controls: comments, then settings. Tooltips and
accessible labels name every icon. The old overview panel, filter strip and
aggregate suggestion count were removed: use the inline/edge decision controls,
the open-comment pill and `Alt+↓`/`Alt+↑` review navigation instead.

### Where are comments and suggestions composed?

Select prose to reveal **Add comment** and **Make suggestion** beside the
selection. The composer and thread actions live in the comments edge on desktop
and in the comments sheet on narrow screens, so authoring and review use one
consistent surface instead of the old top-bar composer. The selected anchor stays
visibly highlighted while its composer is open, then clears when the composer
closes. Existing comments and text-bearing suggestions can be edited without
changing their original author label or CriticMarkup group.

### Can I edit a rendered table without switching the whole document to source?

Yes. Click a rich table cell, or focus it and press Enter/F2, to edit it in
place. Enter commits, Escape cancels, and Tab or Shift-Tab moves between cells.
A normal click edits a linked cell and selects its readable label; modified-click
follows the link. Type `/table` on an otherwise empty line and press Enter to
insert a two-column starter table. The global code/eye control remains the
deliberate, byte-preserving escape to raw Markdown. Source alignment is a separate
explicit, undoable **Format table source** action rather than an automatic rewrite.
Each cell also has a separate comment control. Whole-cell comments use the cell's
exact source range and reopen the matching thread without disrupting table parsing.

### Does ACM render LaTeX?

Yes. Use `$…$` for inline maths and `$$…$$` for display maths. ACM renders both
through KaTeX in prose, table cells, tracked additions and print, including the
standalone binary. Code spans, code fences and currency-like prose stay literal.

### Can I open ACM from another device over Tailscale?

Yes. ACM listens on loopback and refuses any other `Host` (the DNS-rebinding
guard), except hosts you allow: `acm edit doc.md --allow-host mac.tailnet.ts.net`
or `ACM_ALLOWED_HOSTS`. With neither set, the Mac's Tailscale MagicDNS name is
allowed when Tailscale is up (`ACM_ALLOWED_HOSTS=` turns that off). Then
`tailscale serve --bg --https=10464 http://127.0.0.1:12000` and open
`https://<mac>.<tailnet>.ts.net:10464/` on the other device. Open the document with
`acm edit <file>`: the launcher stays local, because opening a document from it moves to a
new port that the tunnel does not follow.

### Can a document show images from outside its folder?

Yes, within its git repository: `![](../../org/docs/assets/run.png)` renders from
a spec anywhere in the same repo. For a document outside a repo, name the folder
with `acm edit doc.md --asset-root <dir>` (or `ACM_ASSET_ROOT`). Only image
types are served, and a path outside the root shows as blocked, not missing.

### How does ACM track who wrote reviewed text?

Markdown remains the source of truth. ACM keeps inspectable range attribution in
`.acm/provenance/<document>.json`, preserving unchanged authors and attributing
human, agent, CLI, external-file and accepted-suggestion writes. Select text to
see its provenance; accepted suggestions retain both proposer and reviewer context.

### Why can a tracked addition appear in the page and in the comments edge?

The page is the proposed content in context. The compact card beside it is only
the decision surface for accepting or rejecting it; it does not repeat the rich
content. In raw mode, where the in-document rich block is disabled, the full
proposal remains visible in the review card. On narrow screens that decision
surface moves into the comments sheet.

### Does ACM render HTML from Markdown?

It renders a conservative, sanitised subset of standard HTML, including tables,
lists, links and inline formatting. That supports a two-column bullet layout with
a standard HTML table. Scripts, event handlers, unsafe URLs, styles and custom
elements such as `<columns>` are removed or left inspectable as source.

### How does printing work?

Cmd/Ctrl-P prints the accepted document state without CriticMarkup delimiters or
review chrome. **Simple** keeps the article conventional and collects footnotes as
endnotes. **Tufte** moves short references into an outer rib; the alternating-side
option places odd-page ribs on the right and even-page ribs on the left, or can be
disabled to keep every rib on the right. ACM measures at A4 print width before the
browser produces the final PDF.

### How does the comments edge behave?

With automatic visibility, a clean document reserves no rail and stays centred.
The first visible comment opens the edge; resolving or filtering the last visible
comment recentres the page. The comments button can explicitly show or hide it.

### What changes on mobile?

The same editor and decisions remain available. Header controls stay touch-sized,
the comments edge becomes a bottom sheet, selection actions stay close to the
selected text, and the document uses the available width instead of reserving a
desktop rail.

### What quality checks does ACM run?

`bun run typecheck` runs TypeScript's `tsc --noEmit`, the closest equivalent to a
Python static type checker such as `ty`. `bun run check` runs that typecheck, the
full Bun test suite, the production and standalone-binary builds, a binary smoke
from outside `node_modules`, and setup tests. ACM currently has no separate
ESLint/Biome-style lint command.

### How was the product demo made?

The Playwright Recast capture was tried first and recorded the real interaction,
but its timing was too abrupt for a clear product story. The final film uses
retina captures from the genuine compiled app, composed with HyperFrames into
slower camera moves, held before/action/after states and larger local captions.
No product UI is mocked. For future demos, `webapp-agent-demo` is the better fit
for naturally flowing live interaction, while HyperFrames remains useful for
deterministic framing; a hybrid can use both.

## How it works for an agent

An agent has two ways to participate, but they are not equally safe while an
editor is live. Reading the `.md` directly is always fine; writes should use the
live ACM instance whenever one owns the document.

1. **Write the file directly only when no ACM editor is running.** Append/insert
   CriticMarkup, for example:
   ```bash
   printf '\n\nNew section. {>>@claude: is this the right place?<<}\n' >> sample-essay.md
   ```
   A blind file write while an editor is live skips ACM's merge and cursor guards
   and can overwrite unsaved human typing.

2. **Use the ACM verbs or HTTP endpoint while an editor is live.** They route the
   mutation through the owning instance so concurrent human edits are merged or
   rejected safely. For example, to drop a comment without hand-writing markup at
   a precise offset:
   ```bash
   curl -X POST localhost:12001/api/comment \
     -H 'content-type: application/json' \
     -d '{"documentPath":"/absolute/path/to/sample-essay.md","anchor":1280,"text":"tighten this","author":"claude"}'
   ```
   Copy `documentPath` from the exact `path` returned by `GET /api/doc`; ACM rejects
   missing or mismatched document identities before writing. `anchor` is a unique
   text span (wrapped `{==…==}` with the comment after it; `422` if absent or
   ambiguous) or a character offset for a point comment, and the comment uses the same
   grammar as the UI.

## Architecture

```
server.ts            Bun.serve — GET/PUT /api/doc, POST /api/comment, WebSocket /ws,
                     a directory watcher + a single content-hash gate (lastKnownHash)
                     that prevents the write→watch→broadcast→clobber feedback loop.
src/server/launcher.ts
                     New/Open/Recent handoff into one explicit document server.
src/lib/             criticmarkup.ts — the one grammar (scan + format + accept/reject),
                     shared by the editor, the sidebar, and the server. types.ts.
src/editor/          CodeMirror 6: a @lezer/markdown CriticMarkup parser, decoration +
                     widget layers, Markdown live-preview, and a thin uncontrolled hook.
src/components/      CommentSidebar (coordsAtPos anchoring, connectors) + Toc.
src/client/          useDocSync — WebSocket pushes + debounced, version-checked saves.
src/App.tsx          Integration: the buffer is ground truth; local edits debounce-save,
                     remote edits rebase via a scroll-preserving ranged diff.
```

**Key invariant:** the CodeMirror plain-text buffer mirrors the file byte-for-byte. There is no separate editor document model — which is exactly what lets an agent read and write the document with no special API.

## Non-goals

One doc per window. No workspace, always-visible file browser or multi-document editor process. No accounts or access levels — sharing, if it ever lands, is your own tunnel exposing your local instance (ADR-0006). No cloud and no multiplayer cursors. Import is a one-shot conversion into the local `.md`; ACM does not retain a Google connection or synchronize changes.
