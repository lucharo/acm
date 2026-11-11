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

When you click **Ask agent to edit** on a thread, `acm threads` marks it `[edit requested]`, so an agent knows to answer with a SUGGEST card.

## Waking the agent from the editor

An agent that opens the document with `acm edit <file.md> --notify` is woken each time you hand it work, so you never switch to its chat to say "I left comments". For as long as the editor runs, the command prints one line on stdout per hand-over and nothing else (the editor's own messages go to stderr):

```text
acm: ask #126zf67 Luis "systematic"
acm: comment #115bygy Luis "in the way it builds"
acm: review 3 threads waiting (2 comments, 1 edit request) - run acm threads
acm: pending #115bygy Luis "in the way it builds"
```

- `ask` is **Ask agent to edit**, which adds an edit request to the thread and always wakes the agent.
- `comment` is a comment or reply of yours, sent only when **Notify agent on each comment** is on (off by default).
- `review` is **Send to agent** in the header: one line for the waiting threads not sent yet, sent when you finish a round.
- `pending` opens a new listener with the work you already sent that the agent has not answered, so work sent while no agent listened still arrives. The editor keeps this in memory: after it restarts, press **Send** again.
- `closed` means the editor stopped; the command exits 1.

A thread is the agent's turn when your name (the **Author** setting) wrote its latest comment. `acm threads` marks those threads `[your turn]`, so the agent's loop is one rule: on each line, run `acm threads`, answer the `[your turn]` threads, and wait for the next line. Every `[your turn]` thread needs a reply (or a resolve); one left unanswered keeps `--wait` returning at once.

The header pill shows whether an agent is listening and how many threads **Send** would hand over; it counts only threads not sent yet, so it reads **Nothing to send** once the agent has them. **Send** and **Ask agent to edit** are on only while an agent listens, or while a `--wait` agent is working on what it last received (**Agent working**). With no agent they are greyed out. If the editor is already open on the file, `--notify` attaches to it instead of starting a second editor, so your clicks in that page reach the agent.

In Claude Code, run the listener under the Monitor tool, which wakes the agent on each stdout line:

```text
Monitor: acm edit essay.md --notify --no-open
```

A Monitor watch ends after at most 30 minutes. When it ends, start it again: if it started the editor, the editor stops with it and the next `--notify` starts a fresh one, so start the editor once in the background (`acm edit essay.md --no-open`) and point the Monitor at `--notify`, which then only attaches.

For a harness that wakes only when a command finishes, use `acm edit <file.md> --wait`: it exits with the first line, or at once when work you sent is still unanswered, and leaves the editor running (it starts one in the background if none is open). Act on the work, then run `--wait` again.

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
