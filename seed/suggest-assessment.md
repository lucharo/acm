# SUGGEST mechanism — fitness assessment doc

This document exercises every suggestion path so the mechanism can be assessed
end-to-end in the running editor. Each section is labelled with the case it tests.

## Case A — anchored SUGGEST, zero gap (#2 inline accept/reject)

In English, {==pay implies a sacrifice, a cost you cannot get back==}{>>@claude: SUGGEST: pay implies a cost you don't get back<<}, which is the metaphor the essay leans on.

## Case B — un-anchored native substitution (free prose)

Attention is arguably our most {~~valueable~>valuable~~} resource, and the one we guard least.

## Case C — anchored SUGGEST with a stray space (ANCHOR_GAP tolerance)

The argument is systematic in the way it builds.

## Case D — SUGGEST that deletes a span (empty replacement)

We should cut the hedge: this is {==quite possibly almost certainly==}{>>@claude: SUGGEST: <<}the strongest claim in the piece.

## Case E — un-anchored SUGGEST (no preceding highlight; quiet affordance, no dead button)

The conclusion needs work. {>>@claude: SUGGEST: rewrite the final paragraph to land on the cost metaphor<<}

## Case F — SUGGEST as a mid-thread reply (#2b inherit thread anchor)

Consider the line {==despite the widespread evidence, people still ignore it==}{>>@luis: is this too strong?<<}{>>@claude: SUGGEST: despite clear evidence, people still ignore it<<}

## Case G — multi-comment anchor density shading (#2c)

The {==misallocation of attention==}{>>@luis: define this?<<}{>>@claude: it's the gap between where attention goes and where it pays<<}{>>@maya: agree, needs a definition<<} is the essay's core idea.

## Case H — plain CriticMarkup for context (insert / delete / point comment)

Writing this piece was {++genuinely++} hard, and I {--really--} wanted it to be {==comprehensive==}{>>@claude: reads well<<}.
