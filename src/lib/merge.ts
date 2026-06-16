// ── 3-way line merge (the two-writer safety net) ──────────────────────────────
// ACM has two writers — the human's editor (full-document saves) and the `acm`
// agent verbs (direct file rewrites). When they touch the doc concurrently a plain
// last-write-wins overwrite DESTROYS one side's content (issue #38: a stale editor
// autosave clobbered an agent's just-written card). This module is the missing
// primitive: a line-based diff3 that keeps BOTH sides when their edits are disjoint
// and reports an honest conflict only when they touch the SAME lines.
//
// Why line-based: it's the granularity `git merge-file`/`diff3` use, and it can
// never garble the inside of a line by interleaving two edits — the failure mode
// that silently corrupts prose. The price is that two edits to the SAME line read
// as a conflict even if textually disjoint; that is SAFE (a false conflict loses
// nothing) and acceptable.
//
// Used identically on both ends (it's pure, isomorphic TS): the server merges every
// write through it (server.ts), and the editor uses it to rebase its in-flight
// buffer onto a server-merged result without dropping the keystrokes typed during
// the save round-trip (useDocSync.ts).

/** Split preserving exact bytes: `s.split("\n")` ↔ `parts.join("\n")` round-trips
 *  perfectly, including a trailing newline (→ a final "" element) or its absence. */
function lines(s: string): string[] {
  return s.split("\n");
}

/** Equality of two line slices. */
function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Longest common subsequence of two line arrays, returned as matched index pairs
 *  [oi, xi] in increasing order. Straightforward O(n·m) DP + backtrack — chosen for
 *  obvious correctness over cleverness; ACM docs are prose (hundreds–thousands of
 *  lines), well within budget. */
function lcsPairs(o: string[], x: string[]): Array<[number, number]> {
  const n = o.length;
  const m = x.length;
  // dp[i][j] = LCS length of o[i:] and x[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = o[i] === x[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (o[i] === x[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

interface Hunk {
  side: "a" | "b";
  oStart: number; // start in base (o)
  oLen: number; // length in base
  sideStart: number; // start in the side buffer (a or b)
  sideLen: number; // length in the side buffer
}

/** Differing regions between base `o` and variant `x`, as the gaps between LCS
 *  matches (and the head/tail beyond the first/last match). */
function diffHunks(o: string[], x: string[], side: "a" | "b"): Hunk[] {
  const pairs = lcsPairs(o, x);
  const hunks: Hunk[] = [];
  let oi = 0;
  let xi = 0;
  const push = (oStart: number, oEnd: number, xStart: number, xEnd: number) => {
    if (oEnd > oStart || xEnd > xStart) {
      hunks.push({ side, oStart, oLen: oEnd - oStart, sideStart: xStart, sideLen: xEnd - xStart });
    }
  };
  for (const [po, px] of pairs) {
    push(oi, po, xi, px);
    oi = po + 1;
    xi = px + 1;
  }
  push(oi, o.length, xi, x.length);
  return hunks;
}

type Region =
  | { stable: true; buffer: "o" | "a" | "b"; start: number; len: number }
  | { stable: false; aStart: number; aLen: number; oStart: number; oLen: number; bStart: number; bLen: number };

/** Align mine (a) and theirs (b) against base (o) into stable runs (taken verbatim
 *  from one buffer) and unstable runs (both sides changed → needs reconciliation).
 *  Mirrors the classic diff3 region algorithm: collect both sides' hunks, sort by
 *  base position, and coalesce hunks whose base ranges touch into one region. */
function regions(a: string[], o: string[], b: string[]): Region[] {
  const hunks = [...diffHunks(o, a, "a"), ...diffHunks(o, b, "b")].sort(
    (p, q) => p.oStart - q.oStart || (p.side < q.side ? -1 : 1),
  );

  const out: Region[] = [];
  let cur = 0; // pointer into base
  const emitStableBase = (end: number) => {
    if (end > cur) out.push({ stable: true, buffer: "o", start: cur, len: end - cur });
    cur = end;
  };

  let idx = 0;
  while (idx < hunks.length) {
    const first = hunks[idx++];
    const regionStart = first.oStart;
    let regionEnd = first.oStart + first.oLen;
    const group: Hunk[] = [first];
    emitStableBase(regionStart);
    // Coalesce every later hunk whose base range overlaps OR TOUCHES this region (`<=`).
    // Touching is deliberately included: line-based diff3 over prose treats edits to
    // ADJACENT lines and competing same-anchor insertions CONSERVATIVELY as one conflict
    // region rather than risk corrupting text by interleaving them. A false conflict is
    // SAFE; a wrong merge is not — and a stricter `<` was shown to silently duplicate AND
    // drop lines on duplicate-line transpositions (git conflicts on those too). Two
    // same-side hunks never coalesce (diffHunks separates them by ≥1 common line), so a
    // multi-hunk group always spans BOTH sides → a genuine conflict.
    while (idx < hunks.length && hunks[idx].oStart <= regionEnd) {
      const next = hunks[idx++];
      regionEnd = Math.max(regionEnd, next.oStart + next.oLen);
      group.push(next);
    }

    if (group.length === 1) {
      // Only one side changed here → take that side's lines verbatim (a pure
      // deletion has sideLen 0 and emits nothing).
      if (first.sideLen > 0) out.push({ stable: true, buffer: first.side, start: first.sideStart, len: first.sideLen });
    } else {
      // Both sides changed overlapping base lines. Map the region's base bounds onto
      // each side via the constant offset of its first/last hunk (base lines outside
      // a side's hunks are common, so they map 1:1).
      const sideBounds = (s: "a" | "b") => {
        const hs = group.filter((h) => h.side === s);
        const f = hs[0];
        const l = hs[hs.length - 1];
        const start = f.sideStart - (f.oStart - regionStart);
        const end = l.sideStart + l.sideLen + (regionEnd - (l.oStart + l.oLen));
        return { start, len: end - start };
      };
      const av = sideBounds("a");
      const bv = sideBounds("b");
      out.push({
        stable: false,
        aStart: av.start,
        aLen: av.len,
        oStart: regionStart,
        oLen: regionEnd - regionStart,
        bStart: bv.start,
        bLen: bv.len,
      });
    }
    cur = regionEnd;
  }
  emitStableBase(o.length);
  return out;
}

export interface MergeResult {
  /** True when no region needed a human decision. `result` is authoritative only
   *  when clean — never write `result` on a conflict. */
  clean: boolean;
  result: string;
}

/**
 * 3-way merge of `mine` and `theirs` against their common ancestor `base`.
 * Disjoint edits (different lines) both survive; edits to the SAME line(s) that
 * differ between the two sides are reported as `clean: false`.
 */
export function merge3(mine: string, base: string, theirs: string): MergeResult {
  // Fast paths — also make the no-op and one-sided cases exact and cheap.
  if (mine === theirs) return { clean: true, result: mine };
  if (base === theirs) return { clean: true, result: mine }; // only `mine` moved
  if (base === mine) return { clean: true, result: theirs }; // only `theirs` moved

  const a = lines(mine);
  const o = lines(base);
  const b = lines(theirs);

  let clean = true;
  const merged: string[] = [];
  for (const r of regions(a, o, b)) {
    if (r.stable) {
      const buf = r.buffer === "a" ? a : r.buffer === "b" ? b : o;
      for (let k = 0; k < r.len; k++) merged.push(buf[r.start + k]);
      continue;
    }
    const aSlice = a.slice(r.aStart, r.aStart + r.aLen);
    const bSlice = b.slice(r.bStart, r.bStart + r.bLen);
    const oSlice = o.slice(r.oStart, r.oStart + r.oLen);
    if (sameLines(aSlice, bSlice)) {
      merged.push(...aSlice); // both made the identical change
    } else if (sameLines(aSlice, oSlice)) {
      merged.push(...bSlice); // a == base here → only b really changed
    } else if (sameLines(bSlice, oSlice)) {
      merged.push(...aSlice); // b == base here → only a really changed
    } else {
      clean = false;
      merged.push(...aSlice); // tentative only; result is ignored when !clean
    }
  }
  return { clean, result: merged.join("\n") };
}

/**
 * The single contiguous span by which `content` differs from `base`, as a
 * shared-prefix/suffix trim. `from`/`to` are the touched range in `base` — used for
 * the cursor-overlap guard. NOTE: for an agent edit that touches SEVERAL separated
 * regions (e.g. accepting a suggestion group), this span spans the untouched text
 * between them too; use `changedFragments` for a containment check, not `inserted`.
 */
export function changedSpan(base: string, content: string): { from: number; to: number; inserted: string } {
  let p = 0;
  const max = Math.min(base.length, content.length);
  while (p < max && base.charCodeAt(p) === content.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && base.charCodeAt(base.length - 1 - s) === content.charCodeAt(content.length - 1 - s)) s++;
  return { from: p, to: base.length - s, inserted: content.slice(p, content.length - s) };
}

/**
 * The content-side text of each line-hunk by which `content` differs from `base` —
 * one entry per contiguous changed region, pure deletions (no new lines) omitted.
 *
 * This is the containment guard for agent writes: after a clean merge EACH fragment
 * must still be present. Using per-hunk fragments (not one contiguous span) means a
 * multi-region agent edit isn't falsely rejected just because the human concurrently
 * edited the untouched text BETWEEN the agent's regions — `merge3` keeps all three,
 * and each agent fragment still appears, so the guard passes as it should.
 */
export function changedFragments(base: string, content: string): string[] {
  if (base === content) return [];
  const o = lines(base);
  const x = lines(content);
  return diffHunks(o, x, "a")
    .filter((h) => h.sideLen > 0)
    .map((h) => x.slice(h.sideStart, h.sideStart + h.sideLen).join("\n"));
}
