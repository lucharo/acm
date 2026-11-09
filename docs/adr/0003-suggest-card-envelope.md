# SUGGEST cards are a highlight+comment envelope, not native markup

Agents proposing edits by writing native CriticMarkup (`{~~old~>new~~}`) at
precise character offsets kept corrupting documents — nesting markup inside
existing constructs, clobbering concurrent edits, and mis-anchoring after the
text shifted. So agent suggestions are encoded as an adjacent pair,
`{==the exact span==}{>>@author: SUGGEST: replacement<<}`: the highlight
anchors by *content*, the comment carries the proposal, and neither can nest
or corrupt. ACM recognises the `SUGGEST:` body and gives the pair the full
suggestion UX (inline substitution-style rendering, accept/reject), so the
envelope is invisible to the human reviewer.

## Consequences

- The pair is a **wire format**: any tool that writes `.md` files can emit a
  valid suggestion with a plain string append — no offset math, no grammar
  beyond "wrap the span, prefix the body". Changing the encoding breaks every
  agent skill that writes it.
- Plain CriticMarkup renderers degrade gracefully: the document shows a
  highlighted span with a comment, not broken markup.
- The document is the only channel — a SUGGEST card needs no server, no API,
  and no ACM instance to be authored.
- The envelope's separator is exactly one space after `SUGGEST:` (or
  `SUGGEST[g:id]:`); everything after it, leading whitespace included, is the
  replacement, so Apply swaps the span for it byte for byte. A hand-written,
  unencoded comment body loses its trailing whitespace when parsed; `acm suggest`
  and the editor store such bodies in the `~acm1~` encoding, which keeps it.
