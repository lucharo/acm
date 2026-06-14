---
name: acm-review
description: Review a prose document in ACM (Agent CriticMarkup) — read the live .md, leave inline comments and threaded replies, and propose edits, all via CriticMarkup. Use when asked to review, comment on, reply in, or suggest edits to a document a human is editing in ACM.
---

# Reviewing in ACM

ACM is a local editor where a human and you collaborate on **one CriticMarkup `.md`
file** — **the file is the source of truth.** You review by reading and writing that
file (or via the server's HTTP API). Everything you write is plain CriticMarkup; the
human sees it rendered live.

## The file is the API

The document path is whatever the human opened (`acm <file>`). Read it, edit it, save
it — the running ACM UI reflects your changes within ~1s. No database, no special
format beyond CriticMarkup.

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
corruption. To suggest **deleting** a span, leave it empty: `SUGGEST:`. (For
references/footnotes, which live in free prose, just write the markdown link inline.)

Decision: **free prose → inline `{~~~>~~}`. Commented/anchored text → `SUGGEST:`.**

**Three rules learned the hard way:**

1. **One comment = one suggestion.** A `SUGGEST:` comment's body is ONLY the
   replacement text — never prefix it with prose (`Moving this… SUGGEST: …`). Mixed
   comments render as a broken/blank card. If you must explain, use a SEPARATE
   adjacent comment.
2. **Anchor directly so it's visible.** Prefer `acm suggest "<span>" "<new>"` — it
   anchors the SUGGEST right on the span, which is what surfaces it in the editor's
   **Suggestions** tab. A SUGGEST *appended at the end of a long thread* still applies
   and renders inline, but the Suggestions tab currently hides it — so don't bury a
   suggestion mid-thread when a direct anchor will do.
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
**only whitespace or highlight delimiters (`{==` / `==}`) separate them**. So to reply,
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

## Suggestion groups — edits that only make sense together

Some edits are one logical change in several places (move a clause = delete here +
re-word there; rename a term across a section). Tag each member with the same group
id — `SUGGEST[g:<id>]: …` — and ACM treats the set as a unit: members render with a
⛓ chip, and the human (or you, via `acm accept --group <id>`) applies or rejects
ALL of them in one atomic step. Author members with `acm suggest … --group <id>`
(pick any short id, e.g. `mv1`). Members can still be accepted individually; the
group controls are the convenience, not a lock.

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
`SUGGEST:` — via `acm comment` / `acm apply edits.json`, so every thread ends in your
voice. **Be confident and proactive:** you don't only respond where they commented — add
standalone `acm suggest` cards and comments wherever you spot an error, a typo, or an
unclear bit. Standalone suggestions (not tied to a thread) are welcome.

## Spelling pass

For long or transcribed prose, run a spell check and turn real typos into Apply-able
cards rather than fixing them silently:

```
uvx codespell <doc>     # DETECT only — never -w (no silent rewrites)
```

For each genuine **prose** typo: `acm suggest "<typo>" "<fix>"`. **Skip** matches inside
comment bodies, footnote definitions, and foreign-language spans (Spanish/German/Māori
trigger false positives), and skip any section the human is still actively rewriting.

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

## Workflow

1. Read the doc; build the thread/anchor map with `scanTokens`/`groupThreads`.
2. Address only **new, non-yours** comments (skip ones already authored by you).
3. For each: insert a threaded reply after its `thread.to`; propose an edit to FREE
   prose with `{++…++}` / `{--…--}` / `{~~old~>new~~}`; or, to edit COMMENT-ANCHORED
   text, attach a `SUGGEST:` comment (see "the ONE hard rule" above).
4. Write the file back (or POST to the server API). Keep edits minimal and signed.

## The `acm` verbs (the blessed surface — prefer these)

For the common review ops, use the CLI verbs instead of hand-editing. They anchor by
**unique text match** (fail safe on ambiguity — nothing applies unless exactly one
target matches), **snapshot the doc before every write** (`<docDir>/.acm/snapshots/`),
and **re-parse + report** after. **No `--doc` needed when ONE ACM editor is running**
— the verbs resolve the doc the human has open (announced on stderr). Resolution
order: `--doc <file.md>` > `ACM_DOC` > the running editor's doc; with several editors
running the verbs refuse and list them rather than guess. Writes go to the file, so
the editor reflects them within ~1s.

```
acm threads [--json]              # read/verify: each thread's anchor, authors, count, [SUGGEST]
acm comment "<phrase>" "<text>"   # reply to the thread whose comment matches <phrase>
acm suggest "<span>" "<new>"      # anchor a SUGGEST: on the unique <span> (may contain complete {++/--/~~} edits — pass the raw text verbatim)
acm suggest … --group <id>        # tag the suggestion as part of group <id> (a SET applied as one unit)
acm accept "<phrase>"             # accept the suggestion matching <phrase> (keep new)
acm reject "<phrase>"             # reject it (keep the original span)
acm accept --group <id>           # accept EVERY suggestion in the group, one atomic write
acm reject --group <id>           # reject the whole group (keep every original span)
acm resolve "<phrase>"            # strip the thread matching <phrase>
acm apply <edits.json>            # batch reply-append; [{id,match,insert}]; idempotent (re-runs skip)
acm wrap [width]                  # hard-wrap prose (default 88 cols); markup-safe — constructs never split
acm import <file.docx> [out.md]   # Word → CriticMarkup .md (tracked changes + comments); validates the result
acm heal                          # repair markup that renders raw (multi-block anchors, trapped/nested comments); snapshot-first
acm history [n]                   # the doc's version journal (auto-recorded by the editor; git shadow repo in .acm/)
acm restore <sha>                 # restore the doc to a journal version (snapshots + journals the current state first)
```

Typical loop: `acm threads --json` to see open threads → `acm comment` / `acm suggest`
per thread (or one `acm apply edits.json` for a batch) → `acm accept`/`reject` to act on
suggestions. `--author <name>` stamps the voice (default `claude`).

## HTTP API / direct file (fallbacks)

When a server is running: `GET /api/doc` → `{content, version}`; `POST /api/comment`
`{anchor,text,author}`; `PUT /api/doc` `{content, baseVersion}` (409 on conflict).
Direct file read/write is always available and simplest for one-offs. Prefer the `acm`
verbs for review work — they snapshot and validate; raw edits don't.

## Voice

Decisive and brief. Lead with the call, weave the reason in. You're a reviewer, not a
narrator — short, concrete, signed.
