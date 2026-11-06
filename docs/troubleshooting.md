# Troubleshooting

Find the message you see and follow the steps under it. Messages are quoted as `acm` prints them.

## Setup

### ACM requires Bun 1.3.14

```text
error: ACM requires Bun 1.3.14; current Bun is 1.4.4
```

Setup builds with the exact Bun version pinned in `package.json`. Run it with that version through `npx`, which leaves your own Bun alone:

```bash
npx --yes bun@1.3.14 run setup
```

### Node is too old for the skills CLI

```text
error: npx skills@1.5.20 requires Node 22.20.0 or newer; current Node is v20.11.0
```

Install Node 22.20 or newer (for example with `fnm install 22`), then run setup again.

### The bin directory is not on PATH

```text
error: /Users/you/.local/bin is not on PATH; add it to PATH or choose another ACM_INSTALL_DIR
```

Add the directory to `PATH` in your shell profile, or point setup at one that is already on it:

```bash
ACM_INSTALL_DIR="$HOME/bin" bun run setup
```

### Setup stops on local changes or an existing file

```text
error: /Users/you/.agents/skills/acm-review has local changes; rerun with --force to back it up before replacement
error: /Users/you/.local/bin/acm already exists and is not ACM; rerun with --force to replace it
```

- The skill message means the installed skill was edited by hand. `bun run setup --force` copies it to `~/.agents/skill-backups/` first. Make lasting changes in the repository's `skills/acm-review/SKILL.md` instead.
- The binary message means another program already uses that name. `--force` replaces it; choose another `ACM_INSTALL_DIR` to keep it.

### The editor still behaves like the old version

Setup replaces the binary but leaves running editors alone. Stop the editor (`Ctrl+C`) and run `acm edit` again.

## Review commands

### No document

```text
--8<-- "no-doc.txt"
```

No editor is running and neither `--doc` nor `ACM_DOC` is set. Pass the file:

```bash
acm threads --doc notes.md
```

### Several editors are running

```text
acm: multiple ACM editors running — pass --doc <file.md> (or set ACM_DOC):
```

`acm` lists the editors and their documents. Pass `--doc` to pick one.

### An editor did not answer its port

```text
acm: an ACM editor did not answer its port (busy machine?) — pass --doc <file.md> rather than guessing:
```

An editor is listed as running but did not reply in time. Retry once the machine is less busy. If that editor is really gone, delete its entry from `instances.json` in `$XDG_CONFIG_HOME/acm/` (default `~/.config/acm/`).

### The text matches more than once, or not at all

```text
--8<-- "ambiguous.txt"
```

Quote a longer span that occurs exactly once. "0 times" means the text is not in the prose, or sits inside existing markup that cannot be wrapped again.

### Unknown option

```text
acm: unknown option "--verbose" (options: --doc --author --group --batch --json --reply; put `--` before text that starts with --)
```

A mistyped option is refused rather than taken as text. If your text really starts with `--`, put `--` before it: `acm suggest -- "--verbose" "--quiet"`.

### NOT applied while you are typing

```text
acm suggest: NOT applied — the human's cursor is in that span in the open editor. Retry in a moment.
acm suggest: NOT applied — the document changed under this edit in the open editor. Retry in a moment.
```

The write overlapped your cursor, or text that changed on disk while the command ran. Nothing was written. Move the cursor or finish typing, then let the agent retry.

## Editor

### Braces show as raw text

A comment nested inside another, a comment inside an inline suggestion, or an anchor that spans two paragraphs stops rendering and shows its braces. A comment that ends up inside an anchor's span leaves its SUGGEST card unable to apply. Heal both:

```bash
acm heal --doc notes.md
```

`acm heal` snapshots the document first and reports how many issues remain.

### Port 12000 is already in use

`acm edit` moves to the next free port by itself and prints the address it chose. To choose one, pass `--port`:

```bash
acm edit notes.md --port 12345
```

### Forbidden when opening ACM from another device

```text
Forbidden: ACM accepts loopback requests only (for remote access: acm edit <file> --allow-host <name>, or ACM_ALLOWED_HOSTS)
```

ACM refuses host names it was not told about. Start it with `--allow-host <name>` for the name in the other device's address bar, or set `ACM_ALLOWED_HOSTS`. See [Getting started](getting-started.md#open-it-from-another-device).

### A Google Doc does not import

```text
acm import: Google Doc is not publicly downloadable; download it as .docx and pass that file path instead
```

The Doc is private. In Google Docs choose **File → Download → Microsoft Word (.docx)** and import that file.

### Unknown command or bare document path

```text
acm: unknown command or bare document path: notes.md
Use: acm edit notes.md
```

Opening a document needs `edit`: `acm edit notes.md`.

---
<!-- doc-audit:last-reviewed -->
_Last reviewed: 2026-11-06 · commit `c0379f7` · verified against code._
