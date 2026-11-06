import { describe, expect, test } from "bun:test";
import { merge3, mergeKeepingBoth, changedSpan, changedFragments, textChangeHunks } from "./merge";

// Byte-preservation is the whole point. This helper asserts a clean merge AND that
// the round-trip is lossless: both sides' changes are present in the result.
function expectClean(mine: string, base: string, theirs: string, result: string) {
  const m = merge3(mine, base, theirs);
  expect(m.clean).toBe(true);
  expect(m.result).toBe(result);
}

describe("merge3 — fast paths", () => {
  test("identical mine/theirs → that content", () => {
    expectClean("same", "old", "same", "same");
  });
  test("only mine changed (theirs === base) → mine", () => {
    expectClean("new", "old", "old", "new");
  });
  test("only theirs changed (mine === base) → theirs", () => {
    expectClean("old", "old", "new", "new");
  });
  test("nobody changed → base", () => {
    expectClean("x", "x", "x", "x");
  });
});

describe("merge3 — disjoint edits both survive (the #38 case)", () => {
  test("human edits para A, agent inserts a card in para B", () => {
    const base = "para A original\n\npara B original\n";
    const human = "para A EDITED BY HUMAN\n\npara B original\n";
    const agent = "para A original\n\npara B original{>>@claude: SUGGEST: tighten<<}\n";
    expectClean(
      human,
      base,
      agent,
      "para A EDITED BY HUMAN\n\npara B original{>>@claude: SUGGEST: tighten<<}\n",
    );
  });

  test("agent's additive insert + human edit far apart", () => {
    const base = "L1\nL2\nL3\nL4\nL5\n";
    const human = "L1\nL2 changed\nL3\nL4\nL5\n";
    const agent = "L1\nL2\nL3\nL4\nL5 {==L5==}{>>@a: SUGGEST: x<<}\n";
    expectClean(human, base, agent, "L1\nL2 changed\nL3\nL4\nL5 {==L5==}{>>@a: SUGGEST: x<<}\n");
  });

  test("both sides insert new (different) lines in different places", () => {
    const base = "a\nb\nc\n";
    const mine = "a\nMINE\nb\nc\n";
    const theirs = "a\nb\nc\nTHEIRS\n";
    expectClean(mine, base, theirs, "a\nMINE\nb\nc\nTHEIRS\n");
  });

  test("agent inserts at end while human edits the top", () => {
    const base = "title\n\nbody line\n";
    const human = "TITLE EDITED\n\nbody line\n";
    const agent = "title\n\nbody line\n\n{>>@claude: note<<}\n";
    expectClean(human, base, agent, "TITLE EDITED\n\nbody line\n\n{>>@claude: note<<}\n");
  });
});

describe("merge3 — identical change on both sides is clean", () => {
  test("both made the exact same edit", () => {
    expectClean("a\nFIX\nc\n", "a\nb\nc\n", "a\nFIX\nc\n", "a\nFIX\nc\n");
  });
});

describe("merge3 — adjacent/competing edits are conservatively flagged (safe, never corrupting)", () => {
  // Line-based diff3 over prose coalesces TOUCHING hunks: edits to adjacent lines and
  // competing same-anchor insertions are reported as conflicts rather than auto-merged.
  // A false conflict is SAFE (nothing dropped/duplicated) — the deliberate tradeoff that
  // keeps the primitive incapable of corrupting text. A stricter `<` rule was tried and
  // shown to silently duplicate AND drop lines on duplicate-line transpositions.
  test("edits to adjacent lines → conflict, not a silent interleave", () => {
    expect(merge3("a\nB\nc\nd\n", "a\nb\nc\nd\n", "a\nb\nC\nd\n").clean).toBe(false);
  });
  test("competing insertions at the same position → conflict", () => {
    expect(merge3("a\nMINE\nb\n", "a\nb\n", "a\nTHEIRS\nb\n").clean).toBe(false);
  });
});

describe("merge3 — never emit a clean merge that DUPLICATES or DROPS a line", () => {
  // Same-anchor uneven insertions / duplicate-line transpositions are ambiguous (git
  // conflicts on them too); the conservative coalescing makes them honest conflicts.
  test("transposition that could duplicate 'a' → conflict, not clean", () => {
    expect(merge3("\n\na", "a\n", "\na").clean).toBe(false);
  });
  test("uneven blank-insertions around 'x' → conflict", () => {
    expect(merge3("\nx", "x\n", "\nx\nx").clean).toBe(false);
  });
  test("duplicate-line transposition that could drop an 'a' → conflict", () => {
    expect(merge3("a\n\na", "a\na\n\n", "para\na\n\na").clean).toBe(false);
  });
  test("a clean merge never contains a line beyond base + both sides' additions", () => {
    const cases: Array<[string, string, string]> = [
      ["x\ny\n", "y\n", "z\ny\n"],
      ["alpha\nbeta\n", "beta\n", "beta\ngamma\n"],
    ];
    for (const [mine, base, theirs] of cases) {
      const m = merge3(mine, base, theirs);
      if (!m.clean) continue;
      const count = (s: string, line: string) => s.split("\n").filter((l) => l === line).length;
      for (const line of new Set(m.result.split("\n"))) {
        const bnd =
          count(base, line) +
          Math.max(0, count(mine, line) - count(base, line)) +
          Math.max(0, count(theirs, line) - count(base, line));
        expect(count(m.result, line)).toBeLessThanOrEqual(bnd);
      }
    }
  });
});

describe("merge3 — true overlap is an honest conflict (never silently merged)", () => {
  test("both edit the SAME line differently", () => {
    const m = merge3("a\nHUMAN\nc\n", "a\nb\nc\n", "a\nAGENT\nc\n");
    expect(m.clean).toBe(false);
  });

  test("human rewrites the very line the agent anchored a card to", () => {
    const base = "the quick brown fox\n";
    const human = "the swift brown fox\n";
    const agent = "the quick {==brown==}{>>@a: SUGGEST: tan<<} fox\n";
    expect(merge3(human, base, agent).clean).toBe(false);
  });

  test("overlapping multi-line edits conflict", () => {
    const m = merge3("a\nX\nY\nd\n", "a\nb\nc\nd\n", "a\nP\nQ\nd\n");
    expect(m.clean).toBe(false);
  });
});

describe("merge3 — byte-exact edge cases", () => {
  test("no trailing newline preserved", () => {
    expectClean("a\nB", "a\nb", "a\nb", "a\nB");
  });
  test("trailing newline preserved when only theirs changes", () => {
    expectClean("a\nb\n", "a\nb\n", "a\nB\n", "a\nB\n");
  });
  test("empty base, both insert same → clean", () => {
    expectClean("hello", "", "hello", "hello");
  });
  test("CRLF lines are treated as content and preserved", () => {
    const base = "a\r\nb\r\nc\r\n";
    const human = "a\r\nB\r\nc\r\n";
    const agent = "a\r\nb\r\nc\r\nADDED\r\n";
    expectClean(human, base, agent, "a\r\nB\r\nc\r\nADDED\r\n");
  });
  test("multibyte content survives a disjoint merge", () => {
    const base = "café\n\nnaïve\n";
    const human = "CAFÉ\n\nnaïve\n";
    const agent = "café\n\nnaïve{>>@a: 🚀<<}\n";
    expectClean(human, base, agent, "CAFÉ\n\nnaïve{>>@a: 🚀<<}\n");
  });
  test("idempotent: re-applying an already-merged state is a no-op", () => {
    const merged = "a\nMINE\nb\nTHEIRS\n";
    expectClean(merged, merged, merged, merged);
  });
});

describe("merge3 — a clean result always contains both sides' changes", () => {
  test("agent marker and human edit both present after merge", () => {
    const base = "alpha\nbeta\ngamma\ndelta\n";
    const human = "alpha\nBETA-EDIT\ngamma\ndelta\n";
    const marker = "{==delta==}{>>@claude: SUGGEST: epsilon<<}";
    const agent = `alpha\nbeta\ngamma\n${marker}\n`;
    const m = merge3(human, base, agent);
    expect(m.clean).toBe(true);
    expect(m.result.includes("BETA-EDIT")).toBe(true);
    expect(m.result.includes(marker)).toBe(true);
  });
});

describe("changedFragments — per-hunk guards survive a human edit between agent regions", () => {
  test("two separated agent edits → two fragments", () => {
    const base = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
    const content = "ALPHA!\nbeta\ngamma\ndelta\nEPSILON!\n";
    expect(changedFragments(base, content)).toEqual(["ALPHA!", "EPSILON!"]);
  });

  test("multi-region agent edit + human edit BETWEEN the regions still passes containment", () => {
    // The Codex finding: a single contiguous guard ("A0..L1..L2..L3..A4") would NOT
    // survive the human's L2 edit and would falsely reject. Per-hunk guards do survive.
    const base = "L0\nL1\nL2\nL3\nL4\n";
    const agent = "A0\nL1\nL2\nL3\nA4\n"; // agent changes L0 and L4
    const human = "L0\nL1\nHUMAN2\nL3\nL4\n"; // human changes the middle (L2)
    const m = merge3(agent, base, human);
    expect(m.clean).toBe(true);
    expect(m.result).toBe("A0\nL1\nHUMAN2\nL3\nA4\n");
    for (const frag of changedFragments(base, agent)) expect(m.result.includes(frag)).toBe(true);
    // The old contiguous span would have been absent → the regression this guards.
    expect(m.result.includes(changedSpan(base, agent).inserted)).toBe(false);
  });
});

describe("changedSpan — extracts the agent's additive insert", () => {
  test("pure insertion at end", () => {
    const base = "hello world\n";
    const content = "hello world{>>@a: note<<}\n";
    const d = changedSpan(base, content);
    expect(d.inserted).toBe("{>>@a: note<<}");
    expect(content.slice(0, d.from) + d.inserted + content.slice(content.length - (base.length - d.to))).toBe(content);
  });
  test("span wrapped as a suggestion marker", () => {
    const base = "keep the brown fox\n";
    const content = "keep the {==brown==}{>>@a: SUGGEST: tan<<} fox\n";
    const d = changedSpan(base, content);
    expect(d.inserted.startsWith("{==brown==}")).toBe(true);
    expect(content.includes(d.inserted)).toBe(true);
  });
  test("no change → empty inserted span", () => {
    expect(changedSpan("x\n", "x\n").inserted).toBe("");
  });
});

describe("textChangeHunks — bounded provenance diff", () => {
  test("keeps distant edits separate when the line matrix exceeds its budget", () => {
    const before = "head\na\nstable\nb\ntail";
    const after = "head\nA\nstable\nB\ntail";

    expect(textChangeHunks(before, after, 0)).toEqual([
      {
        beforeFrom: before.indexOf("\na\n") + 1,
        beforeTo: before.indexOf("\na\n") + 2,
        afterFrom: after.indexOf("\nA\n") + 1,
        afterTo: after.indexOf("\nA\n") + 2,
      },
      {
        beforeFrom: before.lastIndexOf("b"),
        beforeTo: before.lastIndexOf("b") + 1,
        afterFrom: after.lastIndexOf("B"),
        afterTo: after.lastIndexOf("B") + 1,
      },
    ]);
  });
});

describe("mergeKeepingBoth — a human save never stalls on a same-line clash (#88)", () => {
  test("an agent card and the human's words at the same point both survive, card first", () => {
    expect(
      mergeKeepingBoth(
        "alpha line HUMAN\nbeta line\n",
        "alpha line\nbeta line\n",
        "alpha line{>>@claude: note<<}\nbeta line\n",
      ),
    ).toBe("alpha line{>>@claude: note<<} HUMAN\nbeta line\n");
  });

  test("edits at different points of one line merge inside the line", () => {
    expect(
      mergeKeepingBoth(
        "The quick brown fox jumps.",
        "The quick fox jumps.",
        "The quick fox jumps.{>>@c: tense?<<}",
      ),
    ).toBe("The quick brown fox jumps.{>>@c: tense?<<}");
  });

  test("review markup is one unit: the human's letters never land inside an agent's comment", () => {
    expect(mergeKeepingBoth("aXbc", "abc", "a{>>@c: b<<}bc")).toBe("aXbc\na{>>@c: b<<}bc");
    // Edits to neighbouring words are a clash too (conservative, as in merge3).
    expect(mergeKeepingBoth("Run it now", "Run it", "Run {==it==}{>>@c: what?<<}")).toBe(
      "Run it now\nRun {==it==}{>>@c: what?<<}",
    );
  });

  test("two different rewrites of the same words keep both lines, the human's first", () => {
    expect(mergeKeepingBoth("a X c\nend", "a b c\nend", "a Y c\nend")).toBe("a X c\na Y c\nend");
  });

  test("a multi-line review construct is never split between the two versions", () => {
    expect(mergeKeepingBoth("{++human\nbody++}", "{++old\nbody++}", "{++agent\nbody++}")).toBe(
      "{++human\nbody++}\n{++agent\nbody++}",
    );
  });

  test("unchanged documents with multi-line markup come back byte for byte", () => {
    for (const doc of ["", "\n", "x\n{++a\nb++}\ny\n", "{++a\nb++}{>>@c: note\nmore<<}\n\nz", "a {==b\nc==}{>>@d: e<<} f\n"]) {
      expect(mergeKeepingBoth(doc, doc, doc)).toBe(doc);
    }
  });

  test("two lines inserted at the same place stay two lines, the agent's first", () => {
    expect(mergeKeepingBoth("a\nhuman\nb", "a\nb", "a\nagent\nb")).toBe("a\nagent\nhuman\nb");
  });

  test("re-sending the same save does not duplicate what was kept", () => {
    const first = mergeKeepingBoth("human", "old", "agent");
    expect(first).toBe("human\nagent");
    expect(mergeKeepingBoth("human", "old", first)).toBe(first);
  });

  test("two multi-line constructs on one line stay whole when the second is rewritten twice", () => {
    const base = "{++a\nb++}{--c\nd--}";
    const merged = mergeKeepingBoth("{++a\nb++}{--human\nd--}", base, "{++a\nb++}{--agent\nd--}");
    expect(merged).toBe("{++a\nb++}{--human\nd--}\n{++a\nb++}{--agent\nd--}");
  });

  test("re-sending a save whose inserted line was already kept adds nothing", () => {
    const first = mergeKeepingBoth("a\nhuman\nb", "a\nb", "a\nagent\nb");
    expect(mergeKeepingBoth("a\nhuman\nb", "a\nb", first)).toBe(first);
    const inline = mergeKeepingBoth("one two!", "one two", "one two{>>@c: x<<}");
    expect(mergeKeepingBoth("one two!", "one two", inline)).toBe(inline);
  });

  test("typing at the end of a line the agent's version was appended to edits that line", () => {
    expect(mergeKeepingBoth("a X c!", "a X c", "a X c\na Y c")).toBe("a X c!\na Y c");
  });

  test("disjoint line edits merge exactly as merge3 does", () => {
    const mine = "one!\ntwo\nthree";
    const base = "one\ntwo\nthree";
    const theirs = "one\ntwo\nthree?";
    expect(mergeKeepingBoth(mine, base, theirs)).toBe(merge3(mine, base, theirs).result);
  });
});
