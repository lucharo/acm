# Getting started

By the end of this page you have `acm` on your `PATH`, a document open in the editor, and an agent's comments and suggestions on it waiting for your decision.

## Before you start

| You need | Why |
| --- | --- |
| macOS (Apple silicon or Intel) or Linux x64 with glibc | The platforms ACM publishes a binary for. |
| `curl` and `tar` | The installer uses them. You do not need Bun or Node. |
| Claude Code, Codex or another agent | Optional. Without one you can still edit and review by hand. |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/lucharo/acm/main/install.sh | sh
```

The installer does three things, in order:

1. Downloads the latest release for your platform and verifies its SHA-256 checksum.
2. Installs the standalone `acm` executable, with the editor embedded, into `~/.local/bin`.
3. Installs the `acm-review` skill for Codex and Claude Code (`~/.agents/skills/` and `~/.claude/skills/`).

It ends with:

```text
ACM installed: /Users/you/.local/bin/acm
The acm-review skill is installed for Codex and Claude Code.

Open a document:
  acm edit notes.md
```

If `~/.local/bin` is not on your `PATH`, it prints the line to add to your shell profile.

Set these before `sh` to change what it does:

| Variable | Effect |
| --- | --- |
| `ACM_INSTALL_DIR` | Install `acm` somewhere else, for example `"$HOME/bin"` |
| `ACM_VERSION` | Install a specific release, for example `v0.1.0` |
| `ACM_FORCE=1` | Replace an existing `acm` that ACM did not install |

```bash
curl -fsSL https://raw.githubusercontent.com/lucharo/acm/main/install.sh | ACM_INSTALL_DIR="$HOME/bin" sh
```

### With Homebrew

On macOS or Linux x64 with Homebrew, the repository is its own tap. Homebrew 6 and later load a third-party tap only once you trust it:

```bash
brew trust --tap lucharo/acm
brew tap lucharo/acm https://github.com/lucharo/acm.git
brew install lucharo/acm/acm
```

This installs only the `acm` binary, into Homebrew's `bin`. Add the `acm-review` skill with `npx skills add lucharo/acm --skill acm-review`, or run the installer above once. `brew upgrade` then keeps `acm` current: each release updates the formula.

### From source

To build ACM yourself or work on it, you need [Bun](https://bun.sh) 1.3.14 exactly (setup checks the version pinned in `package.json`; with any other, or none, run `npx --yes bun@1.3.14 run setup` instead) and Node 22.20 or newer for `npx skills add`. From a clone:

```bash
bun run setup
```

Setup installs the locked dependencies, builds the binary, and installs it and the skill as above, into a bin directory already on your `PATH`. `ACM_INSTALL_DIR` works here too.

## Open a document

```bash
acm edit notes.md
```

`acm` creates `notes.md` if it does not exist, starts a local server for that one file and opens it in your browser:

```text
--8<-- "edit.txt"
```

- Each `acm edit` serves exactly one document. Open a second document with a second `acm edit`; it takes the next free port.
- `acm edit` with no file opens a launcher with **New**, **Open** and **Recent Documents**.
- Run `acm` on its own for a short overview, `acm --help` for every command, and `acm <command> --help` for one.

Stop the editor with `Ctrl+C` in its terminal once the header shows **Saved**; ACM saves a moment after you stop typing.

## Run your first agent review

The installer added the `acm-review` skill, so your agent already knows the markup and the `acm` commands. Leave the editor running, start your agent in a second terminal (any folder) and ask it in plain words:

```text
Review notes.md in ACM. Comment on anything unclear and suggest tighter wording.
```

The agent writes comments and suggestions into the file, through the running editor so nothing you are typing gets overwritten. They appear as cards beside the prose within about a second.

- An agent session started before the install needs a restart to see the skill.
- Claude Code asks before each `acm` command it runs. Choose "don't ask again" at the first prompt, or add `Bash(acm:*)` to `permissions.allow` in its settings.

![A suggestion group card with its Apply all popover open](assets/suggestion-group.webp)

Then decide on each card: **Accept** or **Reject** a suggestion, **Resolve** a thread you are done with, or reply. [Reviewing](reviewing.md) covers every card and shortcut.

## Open it from another device

ACM only answers on this machine unless you allow another host name. With Tailscale up, the Mac's Tailscale name is allowed by default; otherwise pass `--allow-host`. Start the editor as usual, then in a second terminal forward a port with Tailscale and open `https://<mac>.<tailnet>.ts.net:10464/` on the other device:

```bash
tailscale serve --bg --https=10464 http://127.0.0.1:12000
```

Use the port `acm edit` printed if it is not 12000. Open documents with `acm edit <file>` for this: the launcher stays local, because opening a document from it moves to a new port the forward does not follow.

## What ACM writes on disk

- **The document**: ACM writes it only when you or an agent edit. Opening a file does not rewrite it.
- **A `.acm/` folder beside it**: history, snapshots, provenance and the decision log. It carries its own `.gitignore`, so git ignores it.
- **`$XDG_CONFIG_HOME/acm/`** (default `~/.config/acm/`): settings, seen state, your personal dictionary and the list of running editors.

Changes saved to the document by another editor show up in ACM within about a second.

## Update

Run the install command again:

```bash
curl -fsSL https://raw.githubusercontent.com/lucharo/acm/main/install.sh | sh
```

It replaces the installed binary and the skill in place. An editor that is already running keeps the old version until you stop it and run `acm edit` again.

When the skill has changed, the previous copy moves to a timestamped folder under `~/.agents/skill-backups/`, so any edits you made by hand are kept.

With Homebrew, run `brew upgrade lucharo/acm/acm` instead. From a clone, run `git pull` and `bun run setup`. If you edited the installed skill, setup stops before changing anything; `bun run setup --force` backs it up the same way, then replaces it.

## Import a Google Doc

To review an existing Google Doc or Word file in ACM, convert it once:

```bash
acm import "https://docs.google.com/document/d/<id>/edit"
acm import review-draft.docx
acm import review-draft.docx review.md
```

The result keeps prose, headings, bullet lists, comments with their authors, and tracked insertions and deletions. A link only works for a Doc anyone with the link can view; for a private Doc, download it as `.docx` first. ACM keeps no connection to Google after the import. The output file is written directly and replaced if it exists, with no snapshot, so give it a new name.
