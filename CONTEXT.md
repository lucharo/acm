# ACM — Agent CriticMarkup

A prose editor where a human and agents co-edit one Markdown document through
CriticMarkup: tracked insertions/deletions, inline comments, and suggestions.
This glossary fixes the words for the concepts that recur across the product, so
the UI, the code, and these docs all say the same thing.

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
