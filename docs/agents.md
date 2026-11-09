# Agents

Any agent that can read and write a text file can review in ACM. This page covers how to point one at a document and how its writes stay safe while you are typing.

## The file is the API

- The whole review lives in one CriticMarkup `.md` file: prose, comments, suggestions, groups. There is no database or hidden document model.
- An agent reviews by writing [CriticMarkup](syntax.md) into that file. ACM re-reads it and redraws the page within about a second.
- What ACM keeps beside the file (history, snapshots, provenance, decisions) sits in a `.acm/` folder next to the document. Seen state and settings live in `$XDG_CONFIG_HOME/acm/` (default `~/.config/acm/`). None of it is needed to read the review.

## The acm-review skill

The [installer](getting-started.md#install) adds the `acm-review` skill for Claude Code and Codex. It teaches the agent:

- which markup to write where: inline suggestions in free prose, SUGGEST cards on text that already has a comment on it;
- to sign every comment with `@name:` so you can tell voices apart;
- to group edits that belong together, so you accept them with one **Apply all**;
- to write through the `acm` commands rather than editing the file blindly.

With the skill installed, a plain request is enough:

```text
Review notes.md in ACM. Comment on anything unclear and suggest tighter wording.
```

To change how agents review your documents, tell your agent, or ask it to interview you. It saves what you say in your own `acm-user-preferences` skill, which agents load alongside `acm-review` and ACM updates leave alone. Settings offers **Create your preferences** when you have none and **Edit your preferences** when you do; `acm skill` opens an existing one. Don't edit the installed skill under `~/.agents/skills/`: an update moves those edits to a backup.

The skill's source is [`skills/acm-review/SKILL.md`](https://github.com/lucharo/acm/blob/main/skills/acm-review/SKILL.md).

## Writes that never clobber your typing

| How the agent writes | Document live (editor open) | No editor |
| --- | --- | --- |
| `acm` review commands (`acm comment`, `acm suggest`, …) | ✅ merged with your edits through the editor | ✅ written to the file |
| `POST /api/agent-write` | ✅ merged with your edits | ❌ needs a running editor |
| Writing the file directly (`printf >>`, an editor) | ❌ skips the cursor guard; overlapping typing can be lost | ✅ safe |

- Every review command that writes snapshots the document first, into `.acm/snapshots/` beside it. `acm import` is not a review command: it writes its output file directly.
- While the document is live, a write is refused rather than merged when it overlaps the cursor or selection you moved in the last few seconds, or text that changed on disk while the command ran. The agent retries after you move on.
- Matching is by text: `acm suggest "<span>" …` changes nothing unless exactly one place in the prose matches.

A first review from the shell looks like this:

```text
--8<-- "suggest.txt"
```

The [CLI reference](cli.md) lists every command, and the skill holds the full agent workflow.

When you click **Ask agent** on a thread, `acm threads` marks it `[edit requested]`, so an agent knows to answer with a SUGGEST card.

## Which document the agent edits

The `acm` commands pick the document in this order:

1. `--doc <file.md>`
2. the `ACM_DOC` environment variable
3. the live document of the one running ACM editor

With two editors running and neither of the first two set, the commands refuse and list both editors instead of guessing.

## HTTP endpoints

A running editor also answers on its port. The skill documents the request bodies; the ones an agent uses are:

| Endpoint | Does |
| --- | --- |
| `GET /api/doc` | Returns the live content, its version and the document path |
| `POST /api/comment` | Adds a comment on a unique prose span, or at a character offset |
| `POST /api/agent-write` | Merges a whole new content against the file, with the cursor guard |

Every write request must carry the exact `path` from `GET /api/doc` as `documentPath`, or ACM rejects it before writing.
