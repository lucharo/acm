# ACM visual test fixture

A canonical document exercising every comment / suggestion / tracked-change shape
ACM renders. Use it for visual QA instead of throwaway docs:

    just dev visual-test.md          # random dev port, opens the browser

NOTE: accepting/rejecting/resolving MUTATES the served file. For tests that click
those, serve a COPY (`cp visual-test.md /tmp/vt.md && just dev /tmp/vt.md`) so the
committed fixture stays pristine — or `git restore visual-test.md` afterwards.

## Structured suggestions (SUGGEST:)

Root suggestion (replace): Pay {==implies a sacrifice, a cost you cannot get back==}{>>@claude: SUGGEST: implies a cost you don't get back<<} — renders struck old + green new + inline ✓/✗.

Root suggestion (delete the span): cut this {==redundant trailing clause==}{>>@claude: SUGGEST:<<} entirely — the inline card shows "(delete)".

Reply suggestion (mid-thread): attention is a kind of {==currency we spend==}{>>@luis: is "currency" the right metaphor?<<}{>>@claude: SUGGEST: resource we allocate<<} every waking moment — the suggestion is a reply, yet targets the thread's span; @luis's question survives an accept. (The "💬 2" badge flags the discussion before you accept inline.)

Stray-space tolerance (ANCHOR_GAP): a space between span and comment still resolves — the argument is {==systematic in its build==} {>>@claude: SUGGEST: methodical in its build<<} here.

Un-anchored suggestion (misuse): a point note {>>@claude: SUGGEST: orphan with no span<<} shows the proposal but NO Apply button ("no anchored span to apply to").

Anchor WRAPPING tracked changes (nesting-aware grammar): the {==span keeps {++pending++} and {--dropped--} edits==}{>>@claude: SUGGEST: span keeps its pending edits<<} — whole span struck, nested edits keep their own ✓/✗, suggestion is live in both the inline layer and the sidebar.

Competing suggestions on ONE span ("or" separator): this {==phrasing needs work==}{>>@claude: SUGGEST: phrasing reads rough<<}{>>@maya: SUGGEST: wording needs a pass<<} — the second proposal is prefixed with a muted "or" so the two never read as one run.

## Comment threads & density

Single comment: this span has just {==one note==}{>>@luis: minor<<} on it.

Busy span (multi-comment thread → shaded heavier): the {==key claim here==}{>>@luis: is this clear?<<}{>>@claude: could tighten<<}{>>@luis: agreed, revisit<<} carries three messages.

Point comment (no span): a standalone remark here.{>>@luis: where should this anchor?<<}

## Native tracked changes (free prose)

Substitution with a reply thread: the {~~old wording~>new wording~~}{>>@luis: why?<<}{>>@claude: reads clearer<<} shows a REPLACE card that can hold a discussion.

Insertion: this sentence gains {++an inserted clause++} for emphasis.

Deletion: this sentence loses {--an unnecessary aside--} for brevity.

## Markdown still renders

- bullet one
- bullet two

**Bold**, *italic*, `inline code`, and a [link](https://example.com) should all render normally alongside the markup above.
