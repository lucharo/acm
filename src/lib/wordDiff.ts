// Word-level comparison of a suggested edit's old and new wording (#32), for the
// Google Docs suggesting-mode rendering: unchanged words stay plain, only the
// words that changed are marked. Google's help page describes suggested text as
// appearing "in a new color" and deletions as "crossed out".

export interface DiffPart {
  kind: "same" | "removed" | "added";
  text: string;
}

/** Above this many word pairs the alignment table gets too big to build on every
 *  render; such an edit shows as one removal and one addition instead. */
const MAX_CELLS = 4_000_000;

/** A word with the whitespace after it, or a run of leading whitespace. */
function tokens(text: string): string[] {
  return text.match(/\s+|\S+\s*/g) ?? [];
}

/**
 * The parts of `before` and `after`, in reading order: words both share, words
 * only `before` has (removed) and words only `after` has (added). A removal comes
 * before the addition that replaces it. Joining the same and removed parts gives
 * `before` back exactly; the same and added parts give `after`.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    if (before) push("removed", before);
    if (after) push("added", after);
    return parts;
  }
  // lcs[i][j]: how many tokens a[i..] and b[j..] can share, in order.
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) push("removed", a[i++]);
    else push("added", b[j++]);
  }
  while (i < a.length) push("removed", a[i++]);
  while (j < b.length) push("added", b[j++]);
  return parts;
}

export interface SuggestionSummary {
  kind: "replace" | "add" | "delete";
  before: string;
  after: string;
}

const SUMMARY_CHARS = 50;

function clip(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  if (flat.length <= SUMMARY_CHARS) return flat;
  const head = flat.slice(0, SUMMARY_CHARS + 1);
  const cut = head.lastIndexOf(" ");
  return `${(cut > 0 ? head.slice(0, cut) : flat.slice(0, SUMMARY_CHARS)).replace(/[\s,.;:]+$/, "")}…`;
}

/** The one-line "Replace / Add / Delete" summary of an edit, each side clipped at
 *  a word so a long passage stays one line. */
export function suggestionSummary(before: string, after: string): SuggestionSummary {
  if (!after.trim()) return { kind: "delete", before: clip(before), after: "" };
  if (!before.trim()) return { kind: "add", before: "", after: clip(after) };
  return { kind: "replace", before: clip(before), after: clip(after) };
}
