// ── Spelling review modal ─────────────────────────────────────────────────────
// "Clear the squiggles in one place." Lists every flagged word in the document,
// deduplicated to one row per distinct misspelling (with an occurrence count), in
// document order. Per row: pick a suggestion or type your own to FIX every
// occurrence (one undoable, case-preserving edit), ADD the word to the personal
// dictionary, or IGNORE it for the session. Handled words drop out via a local set;
// the underline and counts update through the engine's own repaint.
//
// The displayed list is derived from `words` (not copied once), so when the engine
// finishes loading after the modal opens, the freshly-scanned list flows straight in.
// Suggestions are computed through a single throttled queue (nspell.suggest can be
// ~100ms) so a document with many misspellings can't tie up the main thread.
//
// The list/fix logic lives in editor/spellcheck.ts (collectFlagged / fixAllEdits) so
// the review and the on-screen squiggles always agree. This file is presentation.

import { useCallback, useEffect, useRef, useState } from "react";
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
  // Words the user has handled this session — filtered out immediately, without
  // waiting for the engine to repaint. Deriving the list (rather than copying it)
  // means a later `words` update — e.g. the dictionary finishing its load — shows up.
  const [handled, setHandled] = useState<Set<string>>(() => new Set());
  const drop = (lower: string) =>
    setHandled((h) => {
      const next = new Set(h);
      next.add(lower);
      return next;
    });
  const list = words.filter((w) => !handled.has(w.lower));

  // One-at-a-time, idle-scheduled queue for the (synchronous, ~100ms) suggest()
  // calls, so opening the modal on a misspelling-heavy doc doesn't block the thread.
  const queueRef = useRef<Array<() => void>>([]);
  const pumpingRef = useRef(false);
  const enqueue = useCallback((task: () => void) => {
    queueRef.current.push(task);
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    const idle = (cb: () => void) =>
      window.requestIdleCallback ? window.requestIdleCallback(() => cb()) : setTimeout(cb, 1);
    const pump = () => {
      const t = queueRef.current.shift();
      if (!t) {
        pumpingRef.current = false;
        return;
      }
      t();
      idle(pump);
    };
    idle(pump);
  }, []);

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
                enqueue={enqueue}
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
  enqueue,
  onFix,
  onAdd,
  onIgnore,
}: {
  word: FlaggedWord;
  suggest: (word: string) => string[];
  enqueue: (task: () => void) => void;
  onFix: (replacement: string) => void;
  onAdd: () => void;
  onIgnore: () => void;
}) {
  // `null` = still queued/computing, `[]` = none found. The compute runs through the
  // shared queue and is skipped if the row unmounts first (modal closed, word handled).
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [custom, setCustom] = useState("");
  useEffect(() => {
    let alive = true;
    enqueue(() => {
      if (alive) setSuggestions(suggest(word.word));
    });
    return () => {
      alive = false;
    };
  }, [enqueue, suggest, word.word]);

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
