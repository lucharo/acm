# The file is the API

ACM has no database and no hidden document model: the single CriticMarkup `.md`
file on disk is the whole state of the collaboration. The editor's plain-text
buffer mirrors the file byte-for-byte; agents participate by reading and writing
that same file with any tool that handles text. The alternative — an internal
document model with an agent-facing API — would have given ACM richer semantics
(stable IDs, structured threads, atomic operations) at the cost of making every
agent integrate against ACM instead of against a text file. We chose the file.

## Consequences

- Any agent, script, or editor works with zero integration — `printf >>` is a
  valid client.
- Everything ACM adds (SUGGEST cards, threads, groups) must be expressible as
  plain text in CriticMarkup — see ADR-0003.
- Anchoring is by content, not by ID: constructs are found again by re-scanning
  the text, and concurrent writes need merge machinery (ADR-0005) rather than
  transactional updates.
- Auxiliary state that is deliberately NOT document content (history, snapshots,
  seen-state, settings) lives beside the doc (`.acm/`) or in config — never in a
  second document model.
