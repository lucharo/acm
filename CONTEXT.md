# ACM — Agent CriticMarkup

A prose editor where a human and agents co-edit one Markdown document through
CriticMarkup: tracked insertions/deletions, inline comments, and suggestions.
This glossary fixes the words for the concepts that recur across the product, so
the UI, the code, and these docs all say the same thing.

## Suggestions & review

**Suggestion**:
Any proposed change to the document awaiting a human accept/reject decision.
An umbrella term with exactly two encodings: the inline suggestion and the
SUGGEST card.
_Avoid_: proposal, edit request, change request.

**Inline suggestion**:
A suggestion encoded natively in CriticMarkup — `{++add++}`, `{--delete--}`,
or `{~~old~>new~~}` — sitting directly in the prose.
_Avoid_: tracked change.

**SUGGEST card**:
A suggestion encoded as a highlight + comment pair,
`{==span==}{>>@author: SUGGEST: replacement<<}`. The corruption-proof envelope
agents use instead of writing inline markup at precise offsets.
_Avoid_: suggestion comment, structured comment.

**Highlight**:
The `{==…==}` construct itself. Standalone, it is a human marking (rendered
yellow) and is not a suggestion.
_Avoid_: mark, span markup.

**Anchor**:
The role a highlight plays when a comment thread or SUGGEST card rides on it —
the span of prose the card is about.
_Avoid_: target, attachment point.

**Thread**:
A run of comments sharing an anchor, rendered as one card. The first comment is
the root; the rest are replies.
_Avoid_: conversation, discussion.

**Accept**:
The verdict that applies a suggestion — the proposed text replaces the original
— and strips its markup from the file.

**Apply**:
The act of landing an accepted suggestion's text — the GUI's button on a SUGGEST
card ("Apply", "Apply all"), and where "applicable" comes from. Accept is the
verdict; apply is what it does to the prose. Not a CLI verb: replying in batch is
`acm reply --batch` (the old `acm apply` spelling is deprecated for this reason).

**Reject**:
The verdict that declines a suggestion — the original text stays — and strips
its markup from the file.

**Resolve**:
The verdict that strips a whole thread (comments and anchor markup) from the
file, keeping the prose. Resolved means no longer in the file; there is no
resolved-but-present state.
_Avoid_: close, dismiss, done.

**Seen**:
Per-thread review state marking what has already been read. Shared context:
both the human and agents should be able to read it.
_Avoid_: read, viewed.

**Card**:
One unit in the right margin: a comment thread, or a suggestion with its
replies.
_Avoid_: bubble, item.

**Suggestion group**:
A set of SUGGEST cards tagged with a shared group id, reviewed and
accepted/rejected as one unit.
_Avoid_: batch, changeset.

**Author**:
The self-declared name a comment or suggestion is signed with (the `@name:`
prefix). The human and agents are authors alike; the label carries no identity
or authentication.
_Avoid_: user, account.

**Applicable**:
The property of a SUGGEST card whose anchor still resolves in the document, so
accepting it is a real action. A non-applicable card still shows its proposal
but offers no verdict.
_Avoid_: valid, actionable.

**Heal**:
Mechanically repair markup that renders raw (broken or mis-nested constructs)
so it renders as intended again.
_Avoid_: fix (reserved for spelling), repair.

**Prose**:
The document text as it reads with every suggestion accepted and all comments
removed — what word count and pagination operate on. (Spell check is looser: it
skips comments but still checks pending deletions and the old side of a
substitution, so it runs on the buffer-minus-comments, not on prose proper.)
_Avoid_: content, body text.

## Reading & instances

**Page view**:
The document rendered as A4 sheets: the sheet styling, the page-break markers,
and the page tally are one concept. (The UI still splits them into two settings —
`page` and `pageBreaks`; merging them is tracked in #40.)
_Avoid_: page breaks (as a separate setting), sheet mode.

**Page**:
The A4 unit the pagination estimate divides the prose into.

**Instance**:
One running ACM server bound to one document on one port.
_Avoid_: session, editor process.

**Live**:
The property of a document currently owned by a running instance. Writes to a
live document route through its instance so they merge instead of clobbering.
_Avoid_: open, active.

## History & recovery

**History**:
The automatically recorded sequence of the document's states, kept while ACM
edits the doc. Each entry is a version.
_Avoid_: journal, log.

**Version**:
A document state recorded in the history; any version can be restored.
_Avoid_: revision. (The save-protocol's version counter is machinery, not this.)

**Snapshot**:
A timestamped copy of the document taken automatically before a mutating agent
operation — the safety net when a single write goes wrong.
_Avoid_: backup.

**Restore**:
Replace the document's content with a chosen version from the history. Restoring
snapshots first, so it is itself reversible.
_Avoid_: rollback, revert.

## Images

**Asset**:
A binary file (an image) stored in the `assets/` folder beside the document and
referenced from the markdown by relative path. The document text stays the one
source of truth; an asset is what a path in it points at.
_Avoid_: attachment, upload, media.

**Insert (an image)**:
The gesture — drag-drop or paste — that saves the bytes as an asset and puts an
image reference in the document at that point.
_Avoid_: upload, embed.

## Spelling

**Misspelling**:
A prose word the active dictionary does not recognise.
_Avoid_: typo, error.

**Flagged**:
The state of a misspelling that is currently underlined — i.e. not silenced by
the personal dictionary or an ignore. The review only lists _flagged_ words, not
every misspelling the engine could produce.

**Spelling review**:
Working through every flagged word in the document in one place, deduplicated to
one entry per distinct misspelling.

**Fix**:
Clear a flag by changing the document text to a correct spelling.
_Avoid_: replace, correct (when naming the action).

**Add to dictionary**:
Clear a flag by accepting the word permanently into the personal dictionary —
correct everywhere thereafter, persisted across documents and instances.
_Avoid_: allow, whitelist.

**Ignore**:
Clear a flag for this session only — not persisted, and the document is
unchanged. Distinct from _Resolve_, which belongs to comment threads, not
spelling.

**Personal dictionary**:
The reader's own accepted words. User-specific and persisted.

**Supplement**:
A bundled, curated list of ordinary words the base dictionaries omit (e.g.
"transformative"). Shipped with the app, the same for everyone — not the
personal dictionary.

**Variant**:
The base dictionary's regional spelling: British or American.
