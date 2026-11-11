// Waking the agent (#31): which threads wait on the agent, which writes produce a
// wake line, and what `--wait` counts as already pending.
import { describe, expect, test } from "bun:test";
import { threadsSummary } from "../lib/agentEdits";
import { AgentWake, formatWakeLine, waitingCounts } from "./agentWake";

const BASE = "Intro. The {==quick fox==}{>>@claude: too vivid?<<} jumps. A {==lazy dog==} sleeps.\n";
const summary = (doc: string) => threadsSummary(doc, new Set(), "Luis");

describe("formatWakeLine", () => {
  test("a thread event names the event, thread, author and anchor", () => {
    expect(formatWakeLine({ event: "comment", threadId: "ab12", author: "Luis", anchor: "quick fox" })).toBe(
      'acm: comment #ab12 Luis "quick fox"',
    );
  });

  test("a point comment has no anchor and a long anchor is shortened", () => {
    expect(formatWakeLine({ event: "ask", threadId: "ab12", author: "Luis", anchor: null })).toBe(
      "acm: ask #ab12 Luis",
    );
    const long = "word ".repeat(30).trim();
    expect(formatWakeLine({ event: "comment", threadId: "x", author: "Luis", anchor: long })).toBe(
      `acm: comment #x Luis "${long.slice(0, 59)}…"`,
    );
  });

  test("a review event counts what is waiting", () => {
    expect(formatWakeLine({ event: "review", comments: 2, editRequests: 1 })).toBe(
      "acm: review 3 threads waiting (2 comments, 1 edit request) - run acm threads",
    );
    expect(formatWakeLine({ event: "review", comments: 1, editRequests: 0 })).toBe(
      "acm: review 1 thread waiting (1 comment, 0 edit requests) - run acm threads",
    );
  });
});

describe("waitingCounts", () => {
  test("splits threads whose last word is the person's into comments and edit requests", () => {
    const doc =
      "The {==quick fox==}{>>@claude: too vivid?<<}{>>@Luis: yes, cut it<<} jumps. " +
      "A {==lazy dog==}{>>@Luis: please suggest an edit<<} sleeps. " +
      "It {==was late==}{>>@Luis: why?<<}{>>@claude: it was night<<}.";
    expect(waitingCounts(summary(doc))).toEqual({ comments: 1, editRequests: 1 });
  });
});

describe("AgentWake.detect", () => {
  test("threads already waiting when the editor starts make no line", () => {
    const doc = BASE.replace("{==lazy dog==}", "{==lazy dog==}{>>@Luis: hmm<<}");
    const wake = new AgentWake(summary(doc));
    expect(wake.detect(summary(doc), true)).toEqual([]);
  });

  test("a new comment from the person makes a comment line when notify-each is on", () => {
    const wake = new AgentWake(summary(BASE));
    const next = BASE.replace("{==lazy dog==}", "{==lazy dog==}{>>@Luis: which dog?<<}");
    const [thread] = summary(next).filter((t) => t.anchor === "lazy dog");
    expect(wake.detect(summary(next), true)).toEqual([
      { event: "comment", threadId: thread.id, author: "Luis", anchor: "lazy dog" },
    ]);
  });

  test("the same comment makes no line when notify-each is off", () => {
    const wake = new AgentWake(summary(BASE));
    const next = BASE.replace("{==lazy dog==}", "{==lazy dog==}{>>@Luis: which dog?<<}");
    expect(wake.detect(summary(next), false)).toEqual([]);
  });

  test("a reply from the person to the agent's thread counts as new work", () => {
    const wake = new AgentWake(summary(BASE));
    const next = BASE.replace("too vivid?<<}", "too vivid?<<}{>>@Luis: agreed<<}");
    const [thread] = summary(next).filter((t) => t.anchor === "quick fox");
    expect(wake.detect(summary(next), true)).toEqual([
      { event: "comment", threadId: thread.id, author: "Luis", anchor: "quick fox" },
    ]);
  });

  test("Ask agent makes an ask line even when notify-each is off", () => {
    const wake = new AgentWake(summary(BASE));
    const next = BASE.replace("too vivid?<<}", "too vivid?<<}{>>@Luis: please suggest an edit<<}");
    const [thread] = summary(next).filter((t) => t.anchor === "quick fox");
    expect(wake.detect(summary(next), false)).toEqual([
      { event: "ask", threadId: thread.id, author: "Luis", anchor: "quick fox" },
    ]);
  });

  test("the agent's own reply makes no line, and a thread reports once", () => {
    const asked = BASE.replace("too vivid?<<}", "too vivid?<<}{>>@Luis: please suggest an edit<<}");
    const wake = new AgentWake(summary(BASE));
    expect(wake.detect(summary(asked), true)).toHaveLength(1);
    expect(wake.detect(summary(asked), true)).toEqual([]);
    const answered = asked.replace("an edit<<}", "an edit<<}{>>@claude: which part?<<}");
    expect(wake.detect(summary(answered), true)).toEqual([]);
  });
});

describe("AgentWake.review and pending", () => {
  test("review sends one line for everything waiting and suppresses the per-comment lines", () => {
    const wake = new AgentWake(summary(BASE));
    const next = BASE.replace("too vivid?<<}", "too vivid?<<}{>>@Luis: agreed<<}").replace(
      "{==lazy dog==}",
      "{==lazy dog==}{>>@Luis: please suggest an edit<<}",
    );
    expect(wake.review(summary(next))).toEqual({ event: "review", comments: 1, editRequests: 1 });
    expect(wake.detect(summary(next), true)).toEqual([]);
  });

  test("pending holds only waiting threads that were sent, until the agent answers", () => {
    const commented = BASE.replace("too vivid?<<}", "too vivid?<<}{>>@Luis: agreed<<}");
    const wake = new AgentWake(summary(BASE));
    wake.detect(summary(commented), false); // notify-each off: not sent
    expect(wake.pending(summary(commented))).toEqual([]);

    wake.review(summary(commented));
    expect(wake.pending(summary(commented)).map((t) => t.anchor)).toEqual(["quick fox"]);

    const answered = commented.replace("agreed<<}", "agreed<<}{>>@claude: cut<<}");
    expect(wake.pending(summary(answered))).toEqual([]);
  });

  test("an Ask agent line is pending without a review", () => {
    const asked = BASE.replace("too vivid?<<}", "too vivid?<<}{>>@Luis: please suggest an edit<<}");
    const wake = new AgentWake(summary(BASE));
    wake.detect(summary(asked), false);
    expect(wake.pending(summary(asked)).map((t) => t.anchor)).toEqual(["quick fox"]);
  });
});
