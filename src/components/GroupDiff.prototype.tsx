// PROTOTYPE, throwaway (prototype/group-diff-variants). Question: how should a
// suggested edit show its before and after in the group panel, so the before is
// as readable as the after? Four variants on the real group panel, switched by
// `?diff=A|B|C|D` and the floating bar; with no `?diff=` the panel renders as on
// main. Nothing here is tested or meant to merge as is.

import { useEffect, useState } from "react";
import type { SuggestionGroupMember } from "../lib/criticmarkup";

export type DiffVariant = "A" | "B" | "C" | "D";
export const DIFF_VARIANTS: { key: DiffVariant; name: string }[] = [
  { key: "A", name: "Docs-style marks in place" },
  { key: "B", name: "Before | After columns" },
  { key: "C", name: "Flip between before and after" },
  { key: "D", name: "New text first, original on demand" },
];

function readVariant(): DiffVariant | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("diff");
  return v === "A" || v === "B" || v === "C" || v === "D" ? v : null;
}

const EVENT = "acm-diff-variant";

export function diffVariant(): DiffVariant | null {
  return readVariant();
}

export function useDiffVariant(): DiffVariant | null {
  const [v, setV] = useState(readVariant);
  useEffect(() => {
    const on = () => setV(readVariant());
    window.addEventListener(EVENT, on);
    window.addEventListener("popstate", on);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener("popstate", on);
    };
  }, []);
  return v;
}

function setVariant(v: DiffVariant) {
  const url = new URL(window.location.href);
  url.searchParams.set("diff", v);
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(EVENT));
  window.dispatchEvent(new Event("resize")); // let the panel re-place at its new width
}

// ── word-level diff (LCS over words, whitespace kept with its word) ──────────
type Op = { kind: "eq" | "del" | "ins"; text: string };

function tokens(s: string): string[] {
  return s.match(/\S+\s*|\s+/g) ?? [];
}

const norm = (t: string) => t.trim();

export function wordDiff(before: string, after: string): Op[] {
  const a = tokens(before);
  const b = tokens(after);
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = norm(a[i]) === norm(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: Op[] = [];
  const push = (kind: Op["kind"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.kind === kind) last.text += text;
    else ops.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (norm(a[i]) === norm(b[j])) {
      push("eq", b[j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", a[i++]);
    else push("ins", b[j++]);
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("ins", b[j++]);
  return ops;
}

const clip = (s: string, max = 56) => {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 20)).replace(/[,.;:]$/, "")}…`;
};

const INK = "text-[var(--ink)]";
const DEL_MUTED = "text-[var(--faint)] line-through decoration-[var(--faint)]";
const INS = "text-[var(--crit-ins)]";
const DEL_TINT = "rounded-[3px] bg-[color-mix(in_srgb,var(--crit-del)_14%,transparent)]";
const INS_TINT = "rounded-[3px] bg-[color-mix(in_srgb,var(--crit-ins)_16%,transparent)]";

/** A: Google Docs suggesting mode. One text, unchanged words in normal ink,
 *  removed words struck in a muted colour, added words coloured; a one-line
 *  "Replace / Add / Delete" summary above it, long passages clipped. */
function VariantA({ edit }: { edit: SuggestionGroupMember }) {
  const before = edit.anchorText;
  const after = edit.isDelete ? "" : edit.replacement;
  const summary = !before
    ? <>Add: <q>{clip(after)}</q></>
    : !after
      ? <>Delete: <q>{clip(before)}</q></>
      : <>Replace: <q>{clip(before)}</q> with <q>{clip(after)}</q></>;
  return (
    <span className="block">
      <span className="mb-1 block text-[11.5px] text-[var(--muted)]">{summary}</span>
      <span className={`block ${INK}`}>
        {wordDiff(before, after).map((op, k) =>
          op.kind === "eq" ? <span key={k}>{op.text}</span>
          : op.kind === "del" ? <span key={k} className={DEL_MUTED}>{op.text}</span>
          : <span key={k} className={INS}>{op.text}</span>,
        )}
      </span>
    </span>
  );
}

/** B: two columns, both in normal ink, changed words tinted on each side. */
function VariantB({ edit }: { edit: SuggestionGroupMember }) {
  const ops = wordDiff(edit.anchorText, edit.isDelete ? "" : edit.replacement);
  return (
    <span className="grid grid-cols-2 gap-3">
      <span className="min-w-0">
        <span className="mb-0.5 block text-[11px] text-[var(--muted)]">Before</span>
        <span className={`block ${INK}`}>
          {ops.filter((o) => o.kind !== "ins").map((o, k) =>
            o.kind === "eq" ? <span key={k}>{o.text}</span> : <span key={k} className={DEL_TINT}>{o.text}</span>,
          )}
        </span>
      </span>
      <span className="min-w-0 border-l border-[var(--line)] pl-3">
        <span className="mb-0.5 block text-[11px] text-[var(--muted)]">After</span>
        <span className={`block ${INK}`}>
          {edit.isDelete ? <span className="italic text-[var(--muted)]">removed</span> : ops.filter((o) => o.kind !== "del").map((o, k) =>
            o.kind === "eq" ? <span key={k}>{o.text}</span> : <span key={k} className={INS_TINT}>{o.text}</span>,
          )}
        </span>
      </span>
    </span>
  );
}

/** C: one side at a time, flipped for the whole panel; changed words underlined. */
function VariantC({ edit, side }: { edit: SuggestionGroupMember; side: "before" | "after" }) {
  const ops = wordDiff(edit.anchorText, edit.isDelete ? "" : edit.replacement);
  const keep = side === "before" ? "del" : "ins";
  const mark = side === "before"
    ? "underline decoration-[var(--crit-del)] decoration-2 underline-offset-[3px]"
    : "underline decoration-[var(--crit-ins)] decoration-2 underline-offset-[3px]";
  if (side === "after" && edit.isDelete) return <span className="italic text-[var(--muted)]">removed</span>;
  return (
    <span className={`block ${INK}`}>
      {ops.filter((o) => o.kind === "eq" || o.kind === keep).map((o, k) =>
        o.kind === "eq" ? <span key={k}>{o.text}</span> : <span key={k} className={mark}>{o.text}</span>,
      )}
    </span>
  );
}

/** The panel-wide before/after switch for variant C. */
export function FlipToggle({ side, onSide }: { side: "before" | "after"; onSide: (s: "before" | "after") => void }) {
  return (
    <span className="mb-2 inline-flex rounded-lg border border-[var(--line-strong)] p-0.5 text-[12px]">
      {(["before", "after"] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={(e) => { e.stopPropagation(); onSide(s); }}
          aria-pressed={side === s}
          className={`rounded-md px-3 py-1 ${side === s ? "bg-[var(--ink)] text-[var(--panel)]" : "text-[var(--muted)] hover:text-[var(--ink)]"}`}
        >
          {s === "before" ? "Before" : "After"}
        </button>
      ))}
    </span>
  );
}

/** D: the proposed text in normal ink with added words marked, the original
 *  behind a disclosure, readable (not struck) with removed words marked. */
function VariantD({ edit }: { edit: SuggestionGroupMember }) {
  const [open, setOpen] = useState(false);
  const ops = wordDiff(edit.anchorText, edit.isDelete ? "" : edit.replacement);
  const changed = ops.filter((o) => o.kind !== "eq").reduce((n, o) => n + o.text.trim().split(/\s+/).filter(Boolean).length, 0);
  return (
    <span className="block">
      <span className={`block ${INK}`}>
        {edit.isDelete ? <span className="italic text-[var(--muted)]">Remove this passage</span> : ops.filter((o) => o.kind !== "del").map((o, k) =>
          o.kind === "eq" ? <span key={k}>{o.text}</span> : <span key={k} className={INS_TINT}>{o.text}</span>,
        )}
      </span>
      {edit.anchorText ? (
        <span className="mt-1 block">
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setOpen(!open); } }}
            className="text-[11.5px] text-[var(--muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--ink)]"
          >
            {open ? "Hide original" : `Show original · ${changed} words changed`}
          </span>
          {open ? (
            <span className="mt-1 block border-l-2 border-[var(--line-strong)] pl-2 text-[var(--muted)]">
              {ops.filter((o) => o.kind !== "ins").map((o, k) =>
                o.kind === "eq" ? <span key={k}>{o.text}</span> : <span key={k} className={`${DEL_TINT} text-[var(--ink)]`}>{o.text}</span>,
              )}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export function EditDiff({ edit, variant, side }: { edit: SuggestionGroupMember; variant: DiffVariant; side: "before" | "after" }) {
  if (variant === "A") return <VariantA edit={edit} />;
  if (variant === "B") return <VariantB edit={edit} />;
  if (variant === "C") return <VariantC edit={edit} side={side} />;
  return <VariantD edit={edit} />;
}

/** The panel width each variant wants; B needs room for two columns. */
export function prototypePanelWidth(base: number): number {
  return readVariant() === "B" ? 720 : base;
}

/** Floating A–D switcher, bottom centre; ←/→ cycle unless typing. */
export function DiffVariantSwitcher() {
  const v = useDiffVariant();
  useEffect(() => {
    if (!v) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, [contenteditable]"))) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const i = DIFF_VARIANTS.findIndex((x) => x.key === v);
      const next = DIFF_VARIANTS[(i + (e.key === "ArrowRight" ? 1 : DIFF_VARIANTS.length - 1)) % DIFF_VARIANTS.length];
      setVariant(next.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [v]);
  if (!v) return null;
  const i = DIFF_VARIANTS.findIndex((x) => x.key === v);
  const step = (d: number) => setVariant(DIFF_VARIANTS[(i + d + DIFF_VARIANTS.length) % DIFF_VARIANTS.length].key);
  return (
    <div data-group-ui className="fixed bottom-4 left-28 z-[60] flex items-center gap-2 rounded-full bg-[#111] px-2 py-1.5 text-[13px] text-white shadow-[0_6px_24px_rgba(0,0,0,0.35)]">
      <button type="button" onClick={() => step(-1)} aria-label="Previous variant" className="h-7 w-7 rounded-full hover:bg-white/15">‹</button>
      <span className="min-w-[17rem] text-center">Prototype {v} · {DIFF_VARIANTS[i].name}</span>
      <button type="button" onClick={() => step(1)} aria-label="Next variant" className="h-7 w-7 rounded-full hover:bg-white/15">›</button>
    </div>
  );
}
