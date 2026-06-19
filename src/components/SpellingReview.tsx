// ── Spelling review modal ─────────────────────────────────────────────────────
// "Clear the squiggles in one place." Lists every flagged word in the document,
// deduplicated to one row per distinct misspelling (with an occurrence count), in
// document order. Per row: pick a suggestion or type your own to FIX every
// occurrence (one undoable, case-preserving edit), ADD the word to the personal
// dictionary, or IGNORE it for the session. Each action drops the row optimistically;
// the underline and counts update through the engine's own repaint. Suggestions are
// computed lazily per row (nspell.suggest can be ~100ms) so the modal opens instantly.
//
// The list/fix logic lives in editor/spellcheck.ts (collectFlagged / fixAllEdits) so
// the review and the on-screen squiggles always agree. This file is presentation.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { FlaggedWord } from "../editor/spellcheck";

export default function SpellingReview({
  words,
  suggest,
  onFix,
  onAdd,
  onIgnore,
  onClose,
}: {
  words: FlaggedWord[];
  suggest: (word: string) => string[];
  onFix: (lower: string, replacement: string) => void;
  onAdd: (word: string) => void;
  onIgnore: (word: string) => void;
  onClose: () => void;
}) {
  // Local copy so handled words leave the list immediately, without waiting for the
  // engine to repaint (Add/Ignore silence a word that's still in the document).
  const [list, setList] = useState<FlaggedWord[]>(words);
  const drop = (lower: string) => setList((l) => l.filter((w) => w.lower !== lower));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[72vh] w-[40rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-[var(--line-strong)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
          <span className="text-[14px] font-semibold text-[var(--ink)]">
            Spelling review
            {list.length ? (
              <span className="ml-2 text-[12px] font-normal text-[var(--faint)]">
                {list.length} word{list.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[12px] text-[var(--muted)] hover:bg-[var(--line)]"
          >
            Esc
          </button>
        </div>

        {list.length === 0 ? (
          <div className="px-4 py-10 text-center text-[14px] text-[var(--muted)]">
            No misspellings — all clear ✓
          </div>
        ) : (
          <ul className="divide-y divide-[var(--line)] overflow-y-auto">
            {list.map((w) => (
              <Row
                key={w.lower}
                word={w}
                suggest={suggest}
                onFix={(replacement) => {
                  onFix(w.lower, replacement);
                  drop(w.lower);
                }}
                onAdd={() => {
                  onAdd(w.word);
                  drop(w.lower);
                }}
                onIgnore={() => {
                  onIgnore(w.word);
                  drop(w.lower);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Row({
  word,
  suggest,
  onFix,
  onAdd,
  onIgnore,
}: {
  word: FlaggedWord;
  suggest: (word: string) => string[];
  onFix: (replacement: string) => void;
  onAdd: () => void;
  onIgnore: () => void;
}) {
  // Lazy: compute suggestions AFTER paint so the modal opens instantly even when
  // many rows each cost ~100ms. `null` = still computing, `[]` = none found.
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [custom, setCustom] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setSuggestions(suggest(word.word)), 0);
    return () => clearTimeout(id);
  }, [suggest, word.word]);

  const submitCustom = (e: FormEvent) => {
    e.preventDefault();
    const v = custom.trim();
    if (v) onFix(v);
  };

  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[14px] font-medium text-[var(--ink)]">{word.word}</span>
        {word.count > 1 ? (
          <span className="text-[11px] tabular-nums text-[var(--faint)]">×{word.count}</span>
        ) : null}

        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {suggestions === null ? (
            <span className="text-[12px] italic text-[var(--faint)]">finding…</span>
          ) : suggestions.length === 0 ? (
            <span className="text-[12px] italic text-[var(--faint)]">no suggestions</span>
          ) : (
            suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onFix(s)}
                title={`Replace all “${word.word}” with “${s}”`}
                className="rounded-md border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-0.5 text-[13px] text-[var(--ink)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                {s}
              </button>
            ))
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onAdd}
            title="Add to your personal dictionary (kept everywhere)"
            className="rounded px-1.5 py-0.5 text-[12px] text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--crit-ins)]"
          >
            + Add
          </button>
          <button
            type="button"
            onClick={onIgnore}
            title="Ignore for this session (document unchanged)"
            className="rounded px-1.5 py-0.5 text-[12px] text-[var(--muted)] hover:bg-[var(--line)]"
          >
            Ignore
          </button>
        </div>
      </div>

      <form onSubmit={submitCustom} className="mt-1.5 flex items-center gap-1.5 pl-0.5">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="replace with…"
          className="w-44 rounded-md border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-0.5 text-[12px] text-[var(--ink)] outline-none focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={!custom.trim()}
          className="rounded-md bg-[var(--accent)] px-2 py-0.5 text-[12px] font-medium text-[var(--panel)] disabled:opacity-40"
        >
          Replace all
        </button>
      </form>
    </li>
  );
}
