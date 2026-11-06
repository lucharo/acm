# CriticMarkup syntax

Everything ACM shows is plain text in the `.md` file. This page is the markup to write by hand or from a script; agents with the `acm-review` skill already know it.

## The five constructs

ACM reads standard [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit):

| Write | Meaning | ACM shows |
| --- | --- | --- |
| `{++added text++}` | Inline suggestion: insert | Green text with ✓ ✗, an **ADD** card |
| `{--removed text--}` | Inline suggestion: delete | Red struck text with ✓ ✗, a **DELETE** card |
| `{~~old~>new~~}` | Inline suggestion: replace | Struck old → green new, a **REPLACE** card |
| `{==span==}` | Highlight | Yellow; a marking only, not a suggestion |
| `{>>note<<}` | Comment | A card in the margin |

## Comments and threads

- **Author**: start a comment with `@name:`. ACM shows the name on the card and colours it per author.

    ```text
    {>>@claude: needs a citation<<}
    ```

- **Anchor**: put the comment straight after a highlight to attach it to that span.

    ```text
    {==In winter the towpath floods==}{>>@Sam: how often?<<}
    ```

- **Reply**: put the next comment straight after the previous one's `<<}`. Comments with nothing between them, or only a stray `{==` / `==}`, form one thread; the first is the root. A space or a newline alone between two comments starts a new thread.

    ```text
    {==In winter the towpath floods==}{>>@Sam: how often?<<}{>>@claude: a few days each winter<<}
    ```

- A comment with no highlight before it is a point comment, attached to where it sits.

## SUGGEST cards

To propose new wording for a span, wrap the span where it already is in a highlight and follow it with a comment that starts with `SUGGEST:` (`acm suggest` does this for you):

```text
{==I don't listen to anything while I walk==}{>>@claude: SUGGEST: I walk without headphones<<}
```

- ACM shows the span struck with the new wording beside it, and a **SUGGESTED EDIT** card with **Apply**.
- An empty `SUGGEST:` proposes deleting the span.
- A `SUGGEST:` written as a reply targets the thread's span, so a thread can end in a concrete edit.

**Why two encodings?** A SUGGEST card is the existing text wrapped in place plus a comment, so an agent writes one with a text search and replace, no character offsets, and it never nests inside other markup. The `acm-review` skill has agents write inline suggestions in free prose, and SUGGEST cards on text that already carries a comment or for a whole-document pass (as one group). Only SUGGEST cards can be accepted from the shell.

## Suggestion groups

Tag SUGGEST cards with the same group id to accept or reject them as one unit. Each card wraps its own span in place:

```text
{==half past seven==}{>>@claude: SUGGEST[g:time]: seven<<}
… later …
{==at half past seven anyway==}{>>@claude: SUGGEST[g:time]: anyway<<}
```

Each card shows a **time · 2 edits** chip with **Apply all**; `acm accept --group time` does the same from the shell. Members can still be accepted one at a time.

Plain comments join a group with `NOTE[g:<id>]:`, and the reviewer can resolve them together:

```text
{==the 2024 figures==}{>>@claude: NOTE[g:facts]: Source: the annual report.<<}
```

## Edit requests

A reply reading `please suggest an edit` (any case; a trailing `.` or `!` is allowed) asks an agent for a SUGGEST card on that thread. The editor's **Ask agent** button writes it, and `acm threads` marks the thread `[edit requested]`.

## Markup that renders raw

Braces showing as plain text usually mean a construct is nested or split across paragraphs. Run `acm heal` to heal it; see [Troubleshooting](troubleshooting.md#braces-show-as-raw-text).

---
<!-- doc-audit:last-reviewed -->
_Last reviewed: 2026-11-06 · commit `c0379f7` · verified against code._
