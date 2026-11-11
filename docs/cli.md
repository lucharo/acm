# CLI reference

Every `acm` command, its options and what it prints. The examples run on a copy of the demo document `seed/docs-demo.md` saved as `morning-walk.md`; the output under each command is real.

??? example "Full `acm --help`"

    ```text
    --8<-- "help.txt"
    ```

## Options shared by the review commands

`threads`, `comment`, `reply`, `suggest`, `accept`, `reject`, `resolve`, `spell`, `heal`, `wrap`, `history`, `restore` and `decisions` take these options (`import` takes none):

| Option | Meaning | Default |
| --- | --- | --- |
| `--doc <file.md>` | The document to work on | `ACM_DOC`, else the live document of the one running editor |
| `--author <name>` | The `@name` written on new comments and suggestions, and the name `acm decisions` records for an accept, reject or resolve | `ACM_AUTHOR`, else `claude` |
| `--group <id>` | Tag a new suggestion or comment with a group id, or act on a whole group (`accept`, `reject`, `spell suggest`) | none |
| `--json` | Machine-readable output (`threads`, `decisions`, `spell`) | off |

Value options take `--doc notes.md` or `--doc=notes.md`. Any other `--word` is refused as an unknown option; put `--` before text that starts with `--`:

```bash
acm suggest -- "--verbose" "--quiet"
```

`acm <command> --help` (or `-h`) prints that command's usage and these options, for example:

??? example "`acm spell --help`"

    ```text
    --8<-- "spell-help.txt"
    ```

How the review commands behave:

- **Matching is by text**, never by id. The quoted argument must match exactly one place, or the command changes nothing, says why and exits 1:

    | Command | The quoted argument matches |
    | --- | --- |
    | `comment`, `suggest` | A span of prose not already inside markup or a code span |
    | `reply`, `resolve` | The text of a comment in the thread |
    | `accept`, `reject` | The proposed wording of a SUGGEST card (a deletion card: its anchor text) |

- **Every write takes a snapshot first**, into `.acm/snapshots/<document>/` beside the document, and prints its path as `backup →`.
- **When the document is live** (an editor has it open), the write goes through that editor and merges with your unsaved typing; otherwise `acm` writes the file directly.
- **After each write** `acm` re-reads the document and prints its comment and SUGGEST-card counts.
- **A write that adds something the editor will flag** still lands and exits 0, but prints a warning on stderr naming each problem's line, thread, anchor and reason (a SUGGEST with no span to apply to, a text that repeats the `@author:` prefix `acm` already writes, markup that renders raw), and its count line ends with `⚠ 1 new SUGGEST won't apply` or `⚠ 1 new markup problem`. Problems the document already had are not reported.

## acm { data-toc-label="acm" }

Prints a short overview.

```text
--8<-- "overview.txt"
```

## acm edit { data-toc-label="edit" }

Opens one document in the editor, creating the file if it is missing. With no file, opens the launcher (**New**, **Open**, **Recent Documents**).

| Option | Meaning | Default |
| --- | --- | --- |
| `<file.md>` | The document to open | none: open the launcher |
| `--port <n>` | Port to serve on | `12000`, or the next free port |
| `--allow-host <name>` | Also accept requests for this host name, such as the Mac's Tailscale name; repeat for several | `ACM_ALLOWED_HOSTS`, else this Mac's Tailscale name when Tailscale is up |
| `--asset-root <dir>` | The folder images may load from | `ACM_ASSET_ROOT`, else the document's git repository, else its folder |
| `--no-open` | Do not open a browser tab (`ACM_NO_OPEN=1` does the same; a set `$BROWSER` is used as the opener) | open one |
| `--notify` | Also print one stdout line each time you hand the agent work, for as long as the editor runs; attaches to an editor already open on the file. See [Waking the agent](agents.md#waking-the-agent-from-the-editor) | off |
| `--wait` | Exit with the first such line, or at once when sent work is unanswered; the editor keeps running | off |

```text
--8<-- "edit.txt"
```

The old spelling `acm notes.md` is refused with a hint to use `acm edit notes.md`.

## acm skill { data-toc-label="skill" }

Opens your `acm-user-preferences` skill in the editor. The skill is yours and ACM doesn't maintain it: your agent creates it when you tell it a lasting preference or ask it to interview you, or use **Create your preferences** in Settings. Until it exists, `acm skill` says so and exits. Takes the same `--port`, `--allow-host`, `--asset-root` and `--no-open` options as `acm edit`.

## acm threads { data-toc-label="threads" }

Lists every comment thread, SUGGEST cards included: id, message count, authors, flags and the start of the anchor. Inline suggestions without a comment are not listed. The `#id` is for reference; commands match by text.

```text
--8<-- "threads.txt"
```

- `[SUGGEST]` marks a SUGGEST card that can still be applied.
- `[seen]` marks a thread you marked seen in the editor; an unmarked line is unseen.
- `[suggestion]` marks a thread on an inline suggestion, which has no seen state.
- `[edit requested]` marks a thread where someone asked for an edit (**Ask agent**, or a reply reading `please suggest an edit`) and no SUGGEST card has answered yet.
- `[your turn]` marks a thread whose latest comment is yours (the editor's **Author** setting): the agent owes it an answer. The last line counts them.
- `--json` prints the same list as JSON.

## acm comment { data-toc-label="comment" }

Adds a new comment on a span of prose: `acm comment "<span>" "<text>"`.

| Option | Meaning |
| --- | --- |
| `--reply`, `-r` | Reply to the thread whose comment matches the first argument, instead of starting a new one (same as `acm reply`) |
| `--group <id>` | Add the new comment to group `<id>` (written as `NOTE[g:<id>]:`), so the reviewer can resolve the notes together |

```text
--8<-- "comment.txt"
```

## acm reply { data-toc-label="reply" }

Replies to the thread whose comment text matches `<phrase>`: `acm reply "<phrase>" "<text>"`.

```text
--8<-- "reply.txt"
```

For many replies in one write, pass a JSON file:

```bash
acm reply --batch edits.json
```

```json
[
  { "id": "bridge", "match": "Which bridge", "insert": "{>>@claude: The one by the lock.<<}" }
]
```

- `match` finds the thread, as in `acm reply`.
- `insert` is the exact markup to add after it, author included.
- Re-running the same file skips replies already there.
- If any item fails, the others are still written and the command exits 1.

## acm suggest { data-toc-label="suggest" }

Proposes new wording for a span of prose as a SUGGEST card: `acm suggest "<span>" "<new wording>"`. An empty new wording proposes deleting the span.

| Option | Meaning |
| --- | --- |
| `--group <id>` | Add the card to suggestion group `<id>`, so the reviewer can accept the set in one step |

```text
--8<-- "suggest.txt"
```

## acm accept and acm reject { data-toc-label="accept, reject" }

Accept puts a SUGGEST card's wording in place; reject keeps the original text. Either way the card's markup leaves the file and any replies stay on the span. Inline suggestions (`{++…++}`, `{--…--}`, `{~~…~~}`) are decided in the editor.

| Form | Acts on |
| --- | --- |
| `acm accept "<phrase>"` | The one SUGGEST card whose proposed wording matches `<phrase>` (a deletion card also matches its anchor text) |
| `acm accept --group <id>` | Every card in the group, in one write |
| `acm reject "<phrase>"`, `acm reject --group <id>` | The same, rejecting |

```text
--8<-- "accept.txt"
```

```text
--8<-- "accept-group.txt"
```

## acm resolve { data-toc-label="resolve" }

Removes the thread whose comment matches `<phrase>`, comments and anchor markup, and keeps the prose: `acm resolve "<phrase>"`.

```text
--8<-- "resolve.txt"
```

## acm spell { data-toc-label="spell" }

Checks spelling with the variant (British or American) and personal dictionary set in the editor.

| Form | Does |
| --- | --- |
| `acm spell` or `acm spell list` | Lists flagged words with suggestions and line numbers (`--json` for JSON) |
| `acm spell suggest [word…]` | Adds one SUGGEST card per flagged occurrence, all in group `spelling` (change with `--group`) |
| `acm spell replace "<word>" "<fix>"` | Replaces every flagged `<word>` in the document, keeping its case |
| `acm spell add <word…>` | Adds words to your personal dictionary, for every document |
| `acm spell ignore <word…>` | Stops flagging words in this document only |

```text
--8<-- "spell.txt"
```

```text
--8<-- "spell-suggest.txt"
```

## acm heal { data-toc-label="heal" }

Heals markup that renders as raw braces or a SUGGEST card that cannot apply (a comment nested in another or trapped inside an inline suggestion, a comment inside an anchor's span, an anchor spanning paragraphs) and reports how many issues remain. Snapshots first.

## acm wrap { data-toc-label="wrap" }

Hard-wraps prose at `[width]` columns (default 88, minimum 20). Markup is never split across lines, so threads and seen state survive.

## acm history { data-toc-label="history" }

Lists the last `[n]` versions (default 20) the editor recorded for the document. The history builds while an editor has the document open.

## acm restore { data-toc-label="restore" }

Replaces the document with a version from `acm history`: `acm restore <sha>`. The current content is snapshotted and recorded first, so a restore can itself be undone. Like every other write, it goes through the editor when the document is live.

## acm decisions { data-toc-label="decisions" }

Lists the last `[n]` accept, reject and resolve decisions (default 20), newest first, with who made them. `--json` for JSON.

## acm import { data-toc-label="import" }

Converts a Google Doc or Word file into a CriticMarkup document: `acm import <Google Docs URL | file.docx> [out.md]`. Comments keep their authors; tracked insertions and deletions become inline suggestions. It writes the output file directly, replacing an existing file without a snapshot. See [Getting started](getting-started.md#import-a-google-doc).

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `ACM_DOC` | review commands, `bun run start` | The document, when `--doc` is not given (`bun run start` refuses to start without it) |
| `ACM_AUTHOR` | review commands | The default `--author` |
| `ACM_PORT` | `bun run start` | Port for the source-mode server |
| `ACM_INSTALL_DIR` | `install.sh`, `bun run setup` | Where to install the `acm` binary |
| `ACM_NO_OPEN` | `acm edit`, `bun run dev` | `1` skips opening a browser tab |
| `ACM_ALLOWED_HOSTS` | `acm edit`, `bun run start` | Extra host names to accept, comma or space separated; set it empty to turn off the Tailscale default |
| `ACM_ASSET_ROOT` | `acm edit`, `bun run start` | The folder images may load from |
| `XDG_CONFIG_HOME` | everything | Settings, personal dictionary and the list of running editors live in `$XDG_CONFIG_HOME/acm/` (default `~/.config/acm/`) |
