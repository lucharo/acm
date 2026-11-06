# One server-side merge authority for concurrent writes

When a doc is open in a live editor, every writer — the human's debounced saves
and each agent edit — routes through that instance's server, which three-way
merges against the last known base instead of letting the file be overwritten
(the last-writer-wins races of #35/#38 corrupted concurrent sessions). Agent CLI
verbs detect a live instance and POST through it; only when no instance owns the
doc do they write the file directly (single writer, no race). A cursor guard
rejects agent edits that land inside the span the human is actively typing in —
the agent is told to retry rather than silently merged into the human's hands.

## Consequences

- Nothing may write the doc bytes directly while an instance owns it — new
  write paths must go through the server's merge, or they reintroduce the
  clobber bug.
- An agent write can be refused (conflict / cursor guard); agent tooling must
  treat "not applied, retry" as a normal outcome, not an error.
- The human editor's save is never refused for a same-line clash (#88): a
  refused save would be re-sent on the same base forever and nothing typed
  afterwards would reach disk. The server keeps both sides instead, merging
  inside the line where the edits don't touch and otherwise keeping both
  versions of the lines, the human's first (`mergeKeepingBoth`).
- If the server answers but doesn't speak the merge protocol (an older build),
  callers fail loudly rather than falling back to a direct write — a live
  editor may hold unsaved human edits.
