---
name: acm-review
description: Review a prose document in ACM (Agent CriticMarkup) — read the live .md, leave inline comments and threaded replies, and propose edits, all via CriticMarkup. Use when asked to review, comment on, reply in, or suggest edits to a document a human is editing in ACM.
---

# Reviewing in ACM

ACM is a local editor where a human and you collaborate on **one CriticMarkup `.md`
file** — **the file is the source of truth.** You review by reading and writing that
file (or via the server's HTTP API). Everything you write is plain CriticMarkup; the
human sees it rendered live.

## The user's review preferences

Load the `acm-user-preferences` skill if it exists, before reviewing. On how to review (tone, what
to flag, when to suggest), it wins over this file. On commands and markup, this file wins.

It belongs to the user and isn't maintained by ACM. The first time the user states a lasting preference for how you
review, create the skill and record the preference in their words, under the suggested structure below. Add later preferences to the
same file; when one replaces or retracts an entry, edit or delete that entry so the file never
contradicts itself. Create it only once the user has stated a preference: never from a guess.

If the skill doesn't exist, offer once per session to interview the user. If they accept, ask about
their tone, what to flag, when to suggest a rewording and when to comment, and words or names to
keep as written. Record their answers in their words.

Put it where you load user-level skills, so it follows the user, and the user can open it in ACM
with `acm skill`:

- Claude Code: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/acm-user-preferences/SKILL.md`
- Agents that read `~/.agents/skills/`: `~/.agents/skills/acm-user-preferences/SKILL.md`

Keep one file. If it already exists in the other place, symlink to it rather than starting a second.

Start the file with:

```markdown
---
name: acm-user-preferences
description: "The user's lasting preferences for reviewing documents in ACM. Load with acm-review before every review."
---
```

Suggested structure, keeping only the sections the user has said something about:

```markdown
# Review preferences

## Tone

## What to flag

## When to suggest a rewording, and when to comment

## Words and names to keep as written
```

The skill belongs to the user. ACM never ships it, so updating ACM never overwrites it.

## The file is the API

The document path is whatever the human opened (`acm edit <file>`). The file is the source
of truth — read it freely, and write through the `acm` verbs (below). The running ACM
UI reflects your changes within ~1s. No database, no special format beyond CriticMarkup.

### Recover the document before branching out

When resuming an interrupted or inherited review, first resolve the live document, inspect
`acm threads` and `acm history`, and state the current review position plus the next
document-owned action. Finish that review loop before starting diagrams, notebooks,
launchers or other supporting work unless the support is directly blocking the document.
An ancillary artefact never substitutes for answering or applying the document's review state.

## CriticMarkup you'll write

- Comment (anchored): `{==the exact span==}{>>@you: your note<<}`
- Comment (point, no span): `{>>@you: your note<<}` right after the text
- Insertion (suggest adding): `{++added text++}`
- Deletion (suggest removing): `{--removed text--}`
- Substitution (suggest replacing): `{~~old~>new~~}`

Always sign with an **`@author:` mention** — e.g. `{>>@claude: tighten this<<}`. The
author shows in the margin and colors the thread, so the human can tell voices apart.

## Suggesting an edit — and the ONE hard rule

Inline suggestions (`{++…++}` / `{--…--}` / `{~~old~>new~~}`) are for **free prose
only**. **Never** place one INSIDE a comment-anchored `{==span==}` — the highlight
stops parsing and the braces leak as raw text (it corrupts the anchor). Most of a
reviewed doc is comment-anchored, so this matters.

To suggest replacing text that sits inside a comment anchor, use a **structured
`SUGGEST:` comment** instead — anchor it to the exact span and put the new wording
after `SUGGEST:`:

```
{==pay implies a sacrifice, a cost you cannot get back==}{>>@claude: SUGGEST: pay implies a cost you don’t get back<<}
```

ACM shows this as a real "Suggested edit" card with the proposed wording and an
**Apply** button that swaps the highlighted span for your wording — no nesting, no
corruption. To suggest **deleting** a span, leave it empty: `SUGGEST:`. To delete a whole
list item, put its marker in the anchor (`{==- the item==}`), or an empty `- ` bullet is
left behind. Apply swaps the span for your wording byte for byte, spaces included: start
and end the span and the replacement on the same kind of boundary (`acm suggest` warns
when they start or end with whitespace). Anchor a code span whole, backticks included
(`` {==`bunx x`==} ``); markup inside backticks renders as literal text. (For
references/footnotes, which live in free prose, just write the markdown link inline.)

Decision: **free prose → inline `{~~~>~~}`. Commented/anchored text → `SUGGEST:`.**
A whole-document pass (typos, grammar, spelling) is the exception: write one `SUGGEST:`
per changed sentence, all in one group (see "Suggestion groups" below), so the human applies
the pass with one "Apply all". Thirty loose inline cards are thirty clicks (2026-10-19: "you
know about grouped edits in acm?" after a mechanics pass shipped as loose cards).

### Human-authored prose stays approval-gated

When the human asks for comments or suggestions, or the document is explicitly
human-authored, **never add substantive prose as a direct document edit**. New headings,
paragraphs, lists and tables are proposals until the human accepts them.

- Free-standing additions become `{++insertion suggestions++}`, one insertion per item or line: a
  multi-line `{++ ++}` rendered as raw markup in the editor (2026-11-04).
- Every comment that makes a point about the text carries its fix: the point in one comment, then a
  `SUGGEST:` card beside it, so the human can apply it rather than retype it (2026-11-04: "you could
  have a comment making your point then your suggestion"). Group the edits with `SUGGEST[g:id]`;
  plain notes join a group only as `NOTE[g:id]` (see "Notes can join a group too" below).
- Keep one space after a list marker. `1.     text` (four or more spaces) is Markdown for a code
  block, and the editor then shows the rest of the list as code (2026-11-04).
- Changes to existing anchored prose use `SUGGEST:`; use a group when several edits form
  one decision.
- Direct edits are reserved for mechanical markup repair or content the human explicitly
  told you to apply, not merely content they asked you to draft or add for review.
- After the write, verify that proposed prose is represented by suggestion tokens rather
  than ordinary Markdown, so the human can accept or reject every contribution.

### Keep feedback brief, proportionate and atomic

- A comment is a sentence or two unless the point genuinely needs more.
- A replacement is about the size of what it replaces: a ten-word span gets roughly ten words
  back, not fifty, unless the human asked for a strong rewrite.
- One change per `SUGGEST:`, on the smallest span that carries it, written in document order so
  the human reviews top to bottom.
- A big restructure is `{++additions++}` for the new material plus `SUGGEST:` only on the precise
  spans that change, never one sweeping replacement (#63).

### Preserve canonical source terminology

Before introducing or renaming a technical term, check the cited primary source and the
project's existing glossary or research notes. Use the source's term exactly when one exists;
do not invent a smoother umbrella label (for example, replacing `serial collapse` with
`anti-collapse`) unless the document explicitly defines it as project-local terminology. If the
source vocabulary is unclear, mark it unknown or ask in the thread instead of turning a
paraphrase into a confident technical term.

**Three rules learned the hard way:**

1. **One comment = one suggestion.** A `SUGGEST:` comment's body is ONLY the
   replacement text — never prefix it with prose (`Moving this… SUGGEST: …`). A mixed
   comment shows as a plain note with no Apply, and ACM flags it as a markup issue. If you must explain, use a SEPARATE
   comment, and know that an adjacent one becomes a reply in the card's thread, which
   applying the card deletes with it. A note that must outlive the card (a review point,
   not an explanation of the edit) goes on its own anchor with prose between it and the
   card's `<<}`, even a single `.` (2026-10-19: an "end on one ask" note threaded under a
   grouped card vanished when Luis applied the group).
2. **Anchor directly so it's visible.** Prefer `acm suggest "<span>" "<new>"` — it
   anchors the SUGGEST right on the span. A SUGGEST *appended at the end of a long
   thread* still applies to the span the thread is about, but a direct anchor reads
   better than one buried mid-thread. A SUGGEST with no span to apply to (no
   `{==span==}` before its thread, or a comment inside the span) is flagged; `acm heal`
   lifts a comment out of an anchor so the SUGGEST applies again.
3. **Be non-destructive.** A "tighten this" suggestion must not nuke a point the human
   values. De-duplicate by KEEPING the unique idea, not deleting it; if a span says two
   things and one repeats, suggest a version that preserves the fresh half. When unsure,
   suggest — don't cut.

One thing that IS allowed (don't avoid it): an anchor may **wrap existing tracked
changes** — `{==a span with {++pending++} edits==}{>>@you: SUGGEST: …<<}` parses and
renders fine (the grammar is nesting-aware for highlights). So you can suggest over a
sentence that already carries `{++…++}`/`{--…--}` edits; accepting your suggestion
replaces the whole span, pending edits included, and rejecting keeps them untouched.
The rule above is only about the REVERSE nesting (an inline suggestion inside a span).

## Replying to a comment (threading)

ACM threads comments by **adjacency**: a comment is a reply to the one before it when
**nothing separates them, or only highlight delimiters (`{==` / `==}`)**. A bare space or
newline between `<<}` and `{>>` starts a new thread. So to reply,
drop your comment **immediately after the target comment's closing `<<}`** — no nesting,
no special syntax:

```
…{>>@luis: is this clear?<<}{>>@claude: yes — and I'd cut the second clause.<<}
```

That renders as a 2-message thread (parent → your reply), parent first.

**A reply can itself be a `SUGGEST:`.** Drop a `SUGGEST:` comment as a reply (right
after another comment in the thread) and it targets the **thread's** anchored span —
so you can propose a concrete edit in the middle of a discussion, not just at the root:

```
{==currency we spend==}{>>@luis: right metaphor?<<}{>>@claude: SUGGEST: a resource we allocate<<}
```

Here `@claude`'s suggestion replaces `currency we spend` (the span the thread is about),
and `@luis`'s question stays attached to the edited span when it's accepted.

## Suggestion groups — edits that only make sense together (reach for these)

When one logical change lands in **more than one place**, group it — don't scatter
the pieces as loose cards the human has to find and approve one by one. Tag each
member with the same group id — `SUGGEST[g:<id>]: …`, authored with
`acm suggest … --group <id>` (pick any short id with no spaces or `]`, e.g. `mv1`). ACM then treats the set
as a unit: members carry a ⛓ chip, the human can **review the whole set in one place**,
and applies or rejects ALL of them atomically (`acm accept --group <id>`, or the card's
"Apply all"). Members can still be accepted individually; the group is the convenience,
not a lock.

**Default to a group whenever edits belong together:**

- **Footnotes** — the marker in the body AND the definition at the bottom are ONE
  change. Group them:
  ```
  acm suggest "universal mind" "universal mind[^um]" --group um   # the marker
  acm suggest "<the last line of the references block>" \
              "<that same line>
  [^um]: the idea of a single mind underlying all reality." --group um   # the definition, appended
  ```
  (Anchor the definition on the current last `[^id]: …` line and replace it with
  itself + a newline + your new def — that keeps it a single applyable card. If you
  also need to fix surrounding punctuation, e.g. a stray `)`, make that a third member
  of the same group.)
  **If a definition card renders raw/mangled** — `[^id]:` lines wrapped in a highlight
  have leaked as raw markup on some builds (seen June 2026) — reject the card, run
  `acm heal`, and add the definition by direct edit instead. Defs are structural lines;
  markers (`[^id]`, no colon) are always safe to card.
- **Rename a term across a section** — one member per occurrence, same group id.
- **Move / re-word a clause** — the deletion here and the re-insertion there, grouped.

If you find yourself listing several related edits as text for the human to paste,
that's the signal to group them into one Apply-all set instead.

**Notes can join a group too.** Many notes of one kind (sources, fact checks) read better
as one group the human resolves in one go: tag each with `NOTE[g:<id>]: …`, authored with
`acm comment "<span>" "<text>" --group <id>`. The group card lists the notes beside any
grouped edits and offers **Resolve all**. Leave a note ungrouped when it needs an answer.

## Find comments precisely (reuse ACM's own parser)

Don't hand-roll regex. ACM ships a parser you can import:

```ts
import { scanTokens, groupThreads } from "<acm>/src/lib/criticmarkup";
const text = await Bun.file(DOC).text();
const comments = scanTokens(text).filter((t) => t.type === "comment");
const threads = groupThreads(comments, text); // each thread.to = where a reply appends
```

`scanTokens` gives every token with exact `{from,to}` offsets, `author`, and `body`.
`groupThreads` returns threads; **`thread.to` is exactly where you insert a reply** so
it threads cleanly. This is the reliable way to locate anchors and avoid mis-edits.

**After EVERY mutating write, gate on a real parse** — the parser catches what delimiter
counting can't (nested comments, literal delimiters in a body, mangled `{~~…~>…~~}`).
Using the same import pattern as above:

```ts
import { validateMarkup, nestedCommentIssues, groupThreads, scanTokens } from "<acm>/src/lib/criticmarkup";
const before = await Bun.file(BACKUP).text(); // your pre-write snapshot
const after = await Bun.file(DOC).text();     // re-read AFTER your write
// DELTA, not absolute: live docs can carry pre-existing diagnostics the human made
// (that's what `acm heal` is for) — only YOUR write adding new ones is corruption.
const diags = (t: string) => validateMarkup(t).length + nestedCommentIssues(t).length;
if (diags(after) > diags(before)) throw "write corrupted markup";
// …and check groupThreads(…).length moved by exactly the delta you intended.
```

The 2-line balance check (`{==` = `==}`, `{>>` = `<<}`, word-count delta vs backup) stays
as a cheap pre-check only. A failure means a corrupted anchor — restore the backup rather
than writing further.
For very large reply sweeps (~20+ threads), one `acm reply --batch <edits.json>` beats N
`acm reply` calls: build `[{id, match, insert}]` from `groupThreads` (`match` = a unique phrase
of the thread's last comment, `insert` = your `{>>@you: …<<}`). It is one verb write (merged,
snapshotted, idempotent, offsets re-scanned per entry); verify the pending count hits 0 afterwards.

## Clearing threads — the reply sweep

A move the human will love at the end of a pass: **reply to every thread still waiting
on you**, so they can resolve the lot in one sweep. A thread is waiting if its **last
comment's author isn't you**:

```ts
const pending = groupThreads(comments, text).filter((th) => {
  const last = th.comments[th.comments.length - 1];
  return (last.author || "").toLowerCase() !== "claude"; // your author name
});
```

Reply to each — an ack ("good call, resolve"), a decision ("go with X"), or a concrete
`SUGGEST:` — via `acm reply` / `acm reply --batch edits.json`, so every thread ends in your
voice. **Be confident and proactive:** you don't only respond where they commented — add
standalone `acm suggest` cards wherever you spot an error, a typo, or an unclear bit;
they anchor on any unique span, no thread needed. For a note with no replacement
wording, `acm comment "<unique span>" "<note>"` anchors a new comment on bare prose
(`{==span==}{>>@you: note<<}`). `acm reply` (= `acm comment --reply`/`-r`) only joins an
EXISTING thread: it matches a comment's text, so it 0-matches on bare prose.

## Spelling pass

For long or transcribed prose, run ACM's own spell check — the SAME engine as the
editor's squiggles (UK/US variant, the user's personal dictionary, and code/URL/comment
skip-regions all honoured), so you never flag what the editor wouldn't:

```
acm spell --json        # every flagged word: count, suggestions, line (DETECT only)
```

Then sort the flagged words into three buckets, and clear the last two first:

- **Genuine prose typo** → `acm spell suggest [word…]` writes one Apply-able card per
  occurrence, all in the group `spelling`, so the human applies the pass with one
  "Apply all" (never a silent rewrite). The fix is the speller's TOP suggestion, which can
  be wrong (`teh` → `ten`): name only the words whose top suggestion is right, and card
  the rest by hand in the same group, `acm suggest "<typo>" "<fix>" --group spelling`.
  Re-running skips words already inside cards. (`acm spell replace` auto-fixes every
  occurrence; in a review, prefer cards the human can accept.)
- **Name / real word the dictionary lacks** (surnames, jargon) → `acm spell add <word…>`
  — goes to the user's persistent personal dictionary. Only add words that are
  unambiguously legitimate; when unsure, leave a comment instead.
- **Foreign-language word valid only in THIS doc** (Spanish/German/Māori spans) →
  `acm spell ignore <word…>` — a per-document ignore list, so it never pollutes the
  global dictionary.

Skip any section the human is still actively rewriting.

## Pacing a large review

- **Calibrate before bulk.** Never fire a 50+ edit batch uncalibrated. Do a small first
  cluster (3–5 edits), show it, get a voice check, then roll the rest. The human's voice
  and tolerance for cuts only become clear after they react to a sample.
- **Re-read the live doc before each pass.** The human edits concurrently, so offsets and
  prose drift — stale anchors are the #1 cause of mis-anchored or dead suggestions.
  Re-read top-to-bottom (or `acm threads --json`) immediately before composing.
- **Honor protected-spot markers.** When the human flags a passage as theirs ("hold on, I
  can try myself", "I'll do it", "I'll write") — leave it. Offer direction, never a
  finished rewrite; the writer's own passages stay their hand.
- **Skip already-answered threads.** Work only the raw, unanswered ones (last comment isn't
  you, and no prior `@claude`/`[Claude]` note). Don't re-litigate settled threads.
- **Pace by what the human has read.** Each thread in `acm threads` carries a `seen` flag
  (`[seen]` in the text listing) — the human's persisted review state from the GUI. Many
  unseen threads means they haven't caught up; prefer answering/refining those over opening
  new ones. Read-only: only the human's editor marks seen. Caveats: `seen: null` means the
  thread rides a raw `{++/--/~~}` suggestion (accept/reject, no seen state), and seen keys
  are global **by content** (author+body), not per-doc — an identical comment in another
  doc shares its seen state, so don't over-trust `[seen]` across docs.
- **Answer edit requests first.** `[edit requested]` in `acm threads` (`editRequested: true`
  in `--json`) means the human clicked **Ask agent**: they want a SUGGEST on that thread's
  span. Answer in the thread: `acm reply "<a phrase from its comment>" "SUGGEST: <new wording>"`
  (a SUGGEST reply inherits the thread's anchor; `acm suggest` refuses a span that is already
  highlighted). A SUGGEST after the request clears the flag.
- **Fresh eyes for the final pass.** Before the doc ships, spawn a read-only copy-editor
  subagent with an explicit voice-preservation brief (list the author's deliberate
  choices: dialect/variant, intentional fragments, their own em-dashes) returning
  `[{anchor, verdict, suggestion}]` JSON with exact-string anchors. Merge its verdicts
  with your own judgment conservatively — it catches what you've gone blind to after
  many passes.

## Being woken by the person (acm edit --notify)

The person can wake you from the editor instead of switching to your chat: **Ask agent** on a
thread, each comment when they turn on "Notify agent on each comment", and **Send N to agent**
at the end of a round. You hear it by listening:

- **Claude Code:** start the editor once in the background (`acm edit <file.md> --no-open`),
  then run `acm edit <file.md> --notify --no-open` under the **Monitor** tool. It attaches to
  the open editor and prints one stdout line per hand-over, each a wake:
  `acm: ask #id Luis "anchor"`, `acm: comment #id …`, `acm: review 3 threads waiting (…)`,
  and on attach `acm: pending #id …` for work sent while nobody listened. `acm: closed …`
  means the editor stopped. A Monitor ends after 30 minutes: re-arm it on expiry.
- **Harnesses that wake only on a finished command:** run `acm edit <file.md> --wait` as a
  background job. It exits with the first line (at once if sent work is unanswered) and
  leaves the editor running; act, then run it again.

On every wake, one rule: `acm threads`, answer each `[your turn]` thread (its latest comment is
the person's), `[edit requested]` ones first with a SUGGEST, then go back to listening. Don't
act on the line's text alone; the doc is the source of truth. Answering a thread (any reply of
yours) takes it off `[your turn]`, so a later `--wait` won't wake you for it again. Reply to (or
resolve) every one, even a "nice!": an unanswered `[your turn]` thread that was sent keeps
`--wait` returning at once.

## Workflow

1. Read the doc; build the thread/anchor map with `scanTokens`/`groupThreads`.
2. Address only **new, non-yours** comments (skip ones already authored by you).
3. For each: insert a threaded reply after its `thread.to`; propose an edit to FREE
   prose with `{++…++}` / `{--…--}` / `{~~old~>new~~}`; or, to edit COMMENT-ANCHORED
   text, attach a `SUGGEST:` comment (see "the ONE hard rule" above).
4. Apply with the `acm` verbs (or `POST /api/agent-write`) so the write merges with the
   human's concurrent edits rather than clobbering them. Keep edits minimal and signed.

## The `acm` verbs (the blessed surface — prefer these)

For the common review ops, use the CLI verbs instead of hand-editing. They anchor by
**unique text match** (fail safe on ambiguity — nothing applies unless exactly one
target matches), **snapshot the doc before every write** (`<docDir>/.acm/snapshots/`),
and **re-parse + report** after. **No `--doc` needed when ONE ACM editor is running**
— the verbs resolve the doc the human has open (announced on stderr). Resolution
order: `--doc <file.md>` > `ACM_DOC` > the running editor's doc; with several editors
running the verbs refuse and list them rather than guess. **They're write-safe by
construction:** when an editor is live they route the write through the server so it
3-way merges with the human's concurrent typing and respects the human's cursor (#38);
with no editor up they write the file directly. Either way the editor reflects the
result within ~1s — and they refuse rather than clobber on conflict.

```
acm threads [--json]              # read/verify: each thread's anchor, authors, count, [SUGGEST], [seen], [edit requested], [your turn]
acm edit <file.md> --notify       # listen: one stdout line per hand-over from the person (run under Monitor)
acm edit <file.md> --wait         # listen once: exit on the first hand-over (or at once if some is unanswered)
acm comment "<span>" "<text>"     # NEW comment anchored on the unique prose <span>: {==span==}{>>@you: text<<}
acm comment … --group <id>        # tag the note as part of group <id> (NOTE[g:id]: …; Resolve all in the GUI)
acm reply "<phrase>" "<text>"     # reply to the thread whose comment matches <phrase> (= acm comment --reply/-r)
acm suggest "<span>" "<new>"      # anchor a SUGGEST: on the unique <span> (may contain complete {++/--/~~} edits — pass the raw text verbatim)
acm suggest … --group <id>        # tag the suggestion as part of group <id> (a SET applied as one unit)
acm accept "<phrase>"             # accept by proposed wording; deletion cards also match anchor prose
acm reject "<phrase>"             # reject by proposed wording or deletion-card anchor (keep original)
acm accept --group <id>           # accept EVERY suggestion in the group, one atomic write
acm reject --group <id>           # reject the whole group (keep every original span)
acm resolve "<phrase>"            # strip the thread matching <phrase>
acm reply --batch <edits.json>    # batch reply-append; [{id,match,insert}] where insert is VERBATIM markup (e.g. "{>>@you: …<<}"); idempotent (re-runs skip); exits 1 if any item failed (the good ones are still written)
acm wrap [width]                  # hard-wrap prose (default 88 cols); markup-safe — constructs never split
acm import <Google-Docs-URL|file.docx> [out.md]  # one-shot import with comments/tracked changes; validates the result
acm heal                          # repair markup that renders raw (multi-block anchors, trapped/nested comments); snapshot-first
acm history [n]                   # the doc's version history (auto-recorded by the editor; git shadow repo in .acm/)
acm restore <sha>                 # restore the doc to a history version (snapshots + records the current state first; goes through the open editor like every verb)
```

Typical loop: `acm threads --json` to see open threads → `acm reply` / `acm suggest`
per thread (or one `acm reply --batch edits.json`) → `acm accept`/`reject` to act on
suggestions. `--author <name>` stamps the voice (default `claude`) on the
single-thread verbs; on `--batch` the author lives inside each `insert` string.
The verbs write `@author:` themselves, so the text you pass starts with the comment or
`SUGGEST:`, never `@claude:`: a doubled prefix hides the `SUGGEST:` and it shows as a plain note.

**Read the warning a write prints.** When a write adds something the editor will flag (a
`SUGGEST:` with no span to apply to, such as a reply on a point comment; a doubled
`@author:` prefix; markup that renders raw), the verb still writes it and exits 0, prints on
stderr `acm <verb>: warning: this write added N problem(s) …` with one line per problem
(line, `thread #id` as `acm threads` shows it, the anchor, the comment id, and why), and ends
its summary line with `⚠ N new SUGGEST won't apply` or `⚠ N new markup problem(s)`. Fix it in
the doc before the person sees it; do not re-run the verb, which would write it twice. Problems
the doc already had are never reported.

## HTTP API / direct file (fallbacks)

When a server is running:
- `GET /api/doc` → `{content, version, path, serverEpoch}` — read the live doc.
- `POST /api/comment` `{documentPath, anchor, text, author}` — drop a comment via
  the shared grammar. A text `anchor` is a unique prose span: it is wrapped `{==…==}`
  with the comment after it, the same rule as `acm comment`; `422` when it is absent or
  ambiguous. A number is a character offset for a point comment. Nothing is written
  on any non-2xx.
- `POST /api/agent-write` `{documentPath, base, content}` — the **agent write path**: the server
  3-way merges your `content` against disk (so the human's concurrent edits survive)
  and runs a **cursor guard** — `409 {conflict:"cursor"}` if the human's caret sits in
  your edited span, `409` on a same-span overlap too. This is what the `acm` verbs POST.
- `PUT /api/doc` `{documentPath, content, baseVersion, serverEpoch}` (409 on conflict) — the
  **human editor's** save, reconciled against the base it started from. The epoch
  must be copied from the latest GET so a restarted server cannot mistake an old
  version number for its own. Every mutating document request must copy the exact
  `path` from that GET as `documentPath`; missing or mismatched paths are rejected
  before writing. Not the agent path.

Reading the file directly is always fine. **Writing the file directly is only safe when
no server is running** — a blind write while an editor is live skips the merge + cursor
guard and can clobber the human's unsaved typing (the exact failure #38 prevents). So
for review work prefer the `acm` verbs: they pick the safe path automatically, snapshot,
and validate; raw writes don't.

Before any scripted read-modify-write, run `acm history 3 --doc <file>`. A newest `edit:` entry
from the last two minutes means the human is in the document (history commits only after a minute
of quiet, so an older entry is weak evidence they have left): use the verbs, which merge
server-side, or wait and re-check. A comment, suggestion or span replacement always goes through
the verbs (#66).

When you genuinely need direct writes with an editor live (bulk scripted transforms the
verbs can't express), do the **stop-the-world dance**: `cp` a timestamped backup → find
the server (`lsof -ti :<port>` filtered to bun/node via `ps -o comm=`) → capture
`md5 -q <doc>` → kill → confirm the md5 is unchanged (no last-moment flush) → edit →
restart the server → re-verify counts. And have the human **close stale editor tabs
before the restart** — a disconnected tab still holds its old buffer, and on reconnect
the user's buffer wins by design ("your version is kept"), which would flush stale
content over your edits.

## Voice

Decisive and brief. Lead with the call, weave the reason in. You're a reviewer, not a
narrator — short, concrete, signed.
