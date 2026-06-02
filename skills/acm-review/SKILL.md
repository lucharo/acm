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

## Replying to a comment (threading)

ACM threads comments by **adjacency**: a comment is a reply to the one before it when
**only whitespace or highlight delimiters (`{==` / `==}`) separate them**. So to reply,
drop your comment **immediately after the target comment's closing `<<}`** — no nesting,
no special syntax:

```
…{>>@luis: is this clear?<<}{>>@claude: yes — and I'd cut the second clause.<<}
```

That renders as a 2-message thread (parent → your reply), parent first.

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

## Workflow

1. Read the doc; build the thread/anchor map with `scanTokens`/`groupThreads`.
2. Address only **new, non-yours** comments (skip ones already authored by you).
3. For each: insert a threaded reply after its `thread.to`, or propose an edit with
   `{++…++}` / `{--…--}` / `{~~old~>new~~}` on the relevant span.
4. Write the file back (or POST to the server API). Keep edits minimal and signed.

## HTTP API (when a server is running)

- `GET  /api/doc` → `{ content, version }`
- `POST /api/comment` `{ anchor, text, author }` → inserts a point comment at `anchor`
- `PUT  /api/doc` `{ content, baseVersion }` → version-checked full write (409 on conflict)

Direct file read/write is always available and simplest; use the API when you want the
server to own the insertion (it broadcasts to the UI immediately).

## Voice

Decisive and brief. Lead with the call, weave the reason in. You're a reviewer, not a
narrator — short, concrete, signed.
