// A suggested edit shown the way Google Docs' suggesting mode shows one (#32): a
// one-line "Replace / Add / Delete" summary, then the passage once, with the words
// both versions share in normal ink, removed words crossed out in a muted colour
// and added words in the suggestion colour. Before, the whole old passage was
// struck through above the whole new one, so a long old passage was hard to read.

import { suggestionSummary, wordDiff } from "../lib/wordDiff";

export function SuggestionDiff({
  before,
  after,
  summaryClassName = "text-[11.5px]",
}: {
  before: string;
  after: string;
  summaryClassName?: string;
}) {
  const summary = suggestionSummary(before, after);
  return (
    <>
      <span className={`block text-[var(--muted)] ${summaryClassName}`}>
        {summary.kind === "replace" ? (
          <>
            Replace: <q>{summary.before}</q> with <q>{summary.after}</q>
          </>
        ) : summary.kind === "add" ? (
          <>
            Add: <q>{summary.after}</q>
          </>
        ) : (
          <>
            Delete: <q>{summary.before}</q>
          </>
        )}
      </span>
      <span className="mt-0.5 block text-[var(--ink)]">
        {wordDiff(before, after).map((part, i) =>
          part.kind === "same" ? (
            <span key={i}>{part.text}</span>
          ) : part.kind === "removed" ? (
            <del key={i} className="text-[var(--faint)] decoration-[var(--faint)]">
              {part.text}
            </del>
          ) : (
            <ins key={i} className="text-[var(--crit-ins)] no-underline">
              {part.text}
            </ins>
          ),
        )}
      </span>
    </>
  );
}
