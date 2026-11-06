// ── Editing-API audit: seeded randomised invariants over the agent-edit verbs ──
// Generates small documents (emoji, CJK, combining marks, CRLF, tables, lists,
// code spans, stray delimiters) and checks, for one SUGGEST card on a unique span:
// markup valid after insert; reject round-trips; accept replaces exactly the span;
// pending cards print their original wording; reply+resolve round-trips; a
// two-member group accepts/rejects as one unit.
//
// A replacement holding CriticMarkup delimiters may be flagged unsafe and refused on
// accept (#94); when it is applied anyway the result must still be valid markup.
// ACM_FUZZ_RUNS=30000 (with `bun test --timeout 600000`) for a deep local run,
// ACM_FUZZ_SEED to move the window.
import { expect, test } from "bun:test";
import {
  addSuggestion,
  addComment,
  resolveSuggestion,
  resolveThread,
  resolveSuggestionGroup,
  AmbiguityError,
} from "../lib/agentEdits";
import {
  validateMarkup,
  acceptedMarkdown,
  scanTokens,
} from "../lib/criticmarkup";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "alpha", "beta", "gamma", "delta", "😀", "日本語", "café", "cafe\u0301", "naïve", "x", "a|b",
  "`code ==} span`", "`<<}`", "**bold**", "[^1]", "_it_", "{", "}", "~", "==", "->", "1.", "#",
];
const SEPS = [" ", " ", " ", "\n", "\r\n", "\n\n", "\r\n\r\n", "\n- ", "\n| ", " | ", "\t"];
const REPLS = [
  "new", "", "😀😀", "日本", " lead", "trail ", "a\nb", "x <<} y", "{==z==}", "p|q", "back\\slash",
  "SUGGEST: nested", "e\u0301",
];

function genDoc(r: () => number): string {
  const n = 1 + Math.floor(r() * 14);
  let d = "";
  for (let i = 0; i < n; i++) {
    d += WORDS[Math.floor(r() * WORDS.length)];
    if (i < n - 1) d += SEPS[Math.floor(r() * SEPS.length)];
  }
  if (r() < 0.5) d += r() < 0.5 ? "\n" : "\r\n";
  return d;
}

/** A substring of doc that occurs exactly once and is non-blank, without crossing a blank line. */
function pickUniqueSpan(r: () => number, doc: string): string | null {
  for (let tries = 0; tries < 30; tries++) {
    const a = Math.floor(r() * doc.length);
    const len = 1 + Math.floor(r() * Math.min(12, doc.length - a));
    let from = a;
    let to = a + len;
    // don't split surrogate pairs
    if (from > 0 && /[\uDC00-\uDFFF]/.test(doc[from])) from--;
    if (to < doc.length && /[\uDC00-\uDFFF]/.test(doc[to])) to++;
    const span = doc.slice(from, to);
    if (!span.trim()) continue;
    if (doc.indexOf(span) !== doc.lastIndexOf(span)) continue;
    return span;
  }
  return null;
}

type Failure = { seed: number; prop: string; detail: unknown };
const failures: Failure[] = [];
const seen = new Set<string>();
function fail(seed: number, prop: string, detail: unknown) {
  if (seen.has(prop)) return; // first counterexample per property
  seen.add(prop);
  failures.push({ seed, prop, detail });
}

function errorsOnly(text: string) {
  return validateMarkup(text);
}

// Written out here rather than imported, so the oracle doesn't share the code's bugs.
const DELIMITER = /\{(\+\+|--|~~|==|>>)|(\+\+|--|~~|==|<<)\}/g;
const delimiterCount = (text: string) => (text.match(DELIMITER) ?? []).length;
const runs = Number(process.env.ACM_FUZZ_RUNS ?? 400);
const base = Number(process.env.ACM_FUZZ_SEED ?? 1);
test("audit: seeded edit invariants hold for one SUGGEST card per document", () => {
  let exercised = 0;
  for (let k = 0; k < runs; k++) {
    const seed = base + k;
    const r = rng(seed);
    const doc = genDoc(r);
    if (scanTokens(doc).length > 0) continue; // start from plain prose
    if (errorsOnly(doc).length > 0) continue;
    const span = pickUniqueSpan(r, doc);
    if (!span) continue;
    const repl = REPLS[Math.floor(r() * REPLS.length)];
    let withSug: string;
    try {
      withSug = addSuggestion(doc, span, "claude", repl);
    } catch (e) {
      if (e instanceof AmbiguityError) continue; // refusing is fine
      fail(seed, "addSuggestion throws non-ambiguity", { doc, span, repl, e: String(e) });
      continue;
    }
    exercised++;
    const at = doc.indexOf(span);
    const expectedAccepted = doc.slice(0, at) + repl + doc.slice(at + span.length);
    // Unsafe = accepting would create a delimiter, from the replacement itself or by
    // joining the text on either side of the splice (e.g. "{" + "" + "==").
    const unsafe = delimiterCount(expectedAccepted) > delimiterCount(doc);
  
    // P1: markup valid after insert
    const errs = errorsOnly(withSug).filter((d) => !(unsafe && (d.kind as string) === "unsafe-suggestion"));
    if (errs.length) fail(seed, "P1 addSuggestion leaves invalid markup", { doc, span, repl, withSug, errs });
  
    // P2: exactly one SUGGEST card exists
    const comments = scanTokens(withSug).filter((t) => t.type === "comment");
    if (comments.length !== 1) fail(seed, "P2 addSuggestion did not produce exactly one comment token", { doc, span, repl, withSug, comments });
  
    // P3: reject round-trips to original
    try {
      const rejected = resolveSuggestion(withSug, span, "reject");
      if (rejected !== doc) fail(seed, "P3 reject != original", { doc, span, repl, withSug, rejected });
    } catch (e) {
      fail(seed, "P3 reject throws", { doc, span, repl, withSug, e: String(e) });
    }
  
    // P4: accept gives span replaced by repl. A replacement holding delimiters may be
    // refused instead (#94); if it is applied, the result must still be valid markup.
    try {
      const accepted = resolveSuggestion(withSug, span, "accept");
      if (unsafe && errorsOnly(accepted).length) fail(seed, "P4 accept of a delimiter-bearing replacement left invalid markup", { doc, span, repl, withSug, accepted });
      if (accepted !== expectedAccepted) fail(seed, "P4 accept != span replaced by replacement", { doc, span, repl, withSug, accepted, expectedAccepted });
    } catch (e) {
      if (!unsafe) fail(seed, "P4 accept throws", { doc, span, repl, withSug, e: String(e) });
    }
  
    // P5: acceptedMarkdown (prose view) agrees with accept
    // (pending SUGGEST cards print their ORIGINAL wording: acceptedMarkdown.test.ts:27)
    const am = acceptedMarkdown(withSug);
    if (am.ok && am.markdown !== doc) fail(seed, "P5 acceptedMarkdown(pending card) != original", { doc, span, repl, withSug, am: am.markdown });
    if (!am.ok) fail(seed, "P5 acceptedMarkdown refused a doc with one valid SUGGEST card", { doc, span, repl, withSug, am });
  
    // P6: reply then resolve thread → original prose
    try {
      const replied = addComment(withSug, "SUGGEST", "human", "ok?");
      const resolved = resolveThread(replied, "ok?");
      if (resolved !== doc) fail(seed, "P6 reply+resolve != original", { doc, span, repl, replied, resolved });
    } catch (e) {
      fail(seed, "P6 reply/resolve throws", { doc, span, repl, withSug, e: String(e) });
    }
  
    // P7: two-member group accept == sequential accept
    const span2 = pickUniqueSpan(r, withSug);
    if (span2 && withSug.indexOf(span2) >= 0 && !unsafe) {
      let g1: string, g2: string;
      try {
        g1 = addSuggestion(doc, span, "claude", repl, "g1");
        g2 = addSuggestion(g1, span2, "claude", "Z", "g1");
      } catch {
        continue;
      }
      try {
        const { content, applied, skipped } = resolveSuggestionGroup(g2, "g1", "accept");
        const rem = scanTokens(content).filter((t) => t.type === "comment" || t.type === "highlight");
        if (applied !== 2 || skipped !== 0 || rem.length !== 0) fail(seed, "P7 group accept not complete", { doc, span, span2, g2, content, applied, skipped });
        // Byte oracle: the group accept equals accepting the two members one by one.
        const sequential = resolveSuggestion(resolveSuggestion(g2, "SUGGEST[g:g1]: Z", "accept"), "SUGGEST[g:g1]", "accept");
        if (content !== sequential) fail(seed, "P7c group accept != sequential accept", { doc, span, span2, g2, content, sequential });
        const rej = resolveSuggestionGroup(g2, "g1", "reject").content;
        if (rej !== doc) fail(seed, "P7b group reject != original", { doc, span, span2, g2, rej });
      } catch (e) {
        fail(seed, "P7 group throws", { doc, span, span2, g2, e: String(e) });
      }
    }
  }
  expect(exercised).toBeGreaterThan(runs / 3); // the generator actually exercised the verbs
  expect(failures).toEqual([]);
});

// Several cards in one document: each verdict touches only its own card, and a
// span with two wrappable occurrences is refused.
test("audit: seeded multi-card invariants (verdicts are local; ambiguity refuses)", () => {
  const W = ["alpha", "beta", "gamma", "😀", "日本語", "cafe\u0301", "x", "y", "zz", "**b**", "|", "-", "1."];
  const S = [" ", " ", "\n", "\r\n", "\n\n", "\n- ", " | "];
  const runs = Number(process.env.ACM_FUZZ_RUNS ?? 300);
  const base = Number(process.env.ACM_FUZZ_SEED ?? 1);
  const firsts = new Map<string, unknown>();
  let exercised = 0;
  let ambiguityChecked = 0;
  for (let k = 0; k < runs; k++) {
    const seed = base + k;
    const r = rng(seed);
    const n = 4 + Math.floor(r() * 16);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(W[Math.floor(r() * W.length)] + (i < n - 1 ? S[Math.floor(r() * S.length)] : ""));
    const doc = parts.join("") + (r() < 0.5 ? "\n" : "");
    // build up to 3 cards with unique markers so they're addressable
    let d = doc;
    const cards: { span: string; repl: string; id: string }[] = [];
    for (let c = 0; c < 3; c++) {
      const tries = 20;
      for (let t = 0; t < tries; t++) {
        const a = Math.floor(r() * d.length);
        const len = 1 + Math.floor(r() * 6);
        let from = a, to = Math.min(d.length, a + len);
        if (from > 0 && /[\uDC00-\uDFFF]/.test(d[from])) from--;
        if (to < d.length && /[\uDC00-\uDFFF]/.test(d[to])) to++;
        const span = d.slice(from, to);
        if (!span.trim() || span.endsWith("{")) continue;
        const id = `R${c}Q`;
        try {
          d = addSuggestion(d, span, "a", `${id}`);
          cards.push({ span, repl: id, id });
          break;
        } catch (e) {
          if (!(e instanceof AmbiguityError)) firsts.set("addSuggestion non-ambiguity throw", firsts.get("addSuggestion non-ambiguity throw") ?? { seed, d, span, e: String(e) });
        }
      }
    }
    if (cards.length < 2) continue;
    exercised++;
    const errs = validateMarkup(d);
    if (errs.length && !firsts.has("invalid after N cards")) firsts.set("invalid after N cards", { seed, doc, d, errs });
  
    // P: rejecting every card (any order) returns the original doc
    let rej = d;
    const order = [...cards].sort(() => r() - 0.5);
    try {
      for (const c of order) rej = resolveSuggestion(rej, c.id, "reject");
      if (rej !== doc && !firsts.has("reject-all != original")) firsts.set("reject-all != original", { seed, doc, d, rej, order: order.map((c) => c.id) });
    } catch (e) {
      if (!firsts.has("reject-all throws")) firsts.set("reject-all throws", { seed, doc, d, e: String(e), order: order.map((c) => c.id) });
    }
    // P: replying to one card then resolving it leaves the other cards byte-identical
    try {
      const target = cards[0];
      const replied = addComment(d, target.id, "h", `reply-${seed}`);
      const resolved = resolveThread(replied, `reply-${seed}`);
      const others = scanTokens(resolved).filter((t) => t.type === "comment").map((t) => t.raw).sort();
      const expected = scanTokens(d).filter((t) => t.type === "comment" && !t.raw.includes(target.id)).map((t) => t.raw).sort();
      if (JSON.stringify(others) !== JSON.stringify(expected) && !firsts.has("resolve touched other cards")) firsts.set("resolve touched other cards", { seed, d, resolved });
      // resolve keeps target's ORIGINAL span (no accept)
      const back = cards.slice(1).reduce((acc, c) => resolveSuggestion(acc, c.id, "reject"), resolved);
      if (back !== doc && !firsts.has("resolve+reject-rest != original")) firsts.set("resolve+reject-rest != original", { seed, doc, d, resolved, back });
    } catch (e) {
      if (!firsts.has("reply/resolve throws")) firsts.set("reply/resolve throws", { seed, d, e: String(e) });
    }
    // P: an ambiguous span (2+ wrappable occurrences) must throw
    const dup = d + "\n\nDUPSPAN and DUPSPAN\n";
    ambiguityChecked++;
    try {
      const out = addSuggestion(dup, "DUPSPAN", "a", "x");
      if (!firsts.has("ambiguous span accepted")) firsts.set("ambiguous span accepted", { seed, out });
    } catch (e) {
      if (!(e instanceof AmbiguityError) && !firsts.has("ambiguous span wrong error")) firsts.set("ambiguous span wrong error", { seed, e: String(e) });
    }
  }
  expect(exercised).toBeGreaterThan(runs / 2);
  expect(Object.fromEntries(firsts)).toEqual({});
});
