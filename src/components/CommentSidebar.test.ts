import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import CommentSidebar from "./CommentSidebar";
import type { SidebarCard } from "../lib/types";

function renderSidebar(cards: SidebarCard[], richPreview = true): string {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(CommentSidebar as never, {
      view: null,
      cards,
      richPreview,
      activeId: null,
      seenIds: new Set<string>(),
      showSeen: false,
      unseenCount: 0,
      onToggleSeen: noop,
      repositionKey: 0,
      replyTarget: null,
      onResolveThread: noop,
      onDeleteComment: noop,
      onReply: noop,
      onReplyAndSeen: noop,
      onSuggestEdit: noop,
      onApplySuggestion: noop,
      onApplyAndResolveSuggestion: noop,
      onRejectSuggestionEdit: noop,
      applicableSuggestionIds: new Set<string>(),
      suggestionGroupOf: new Map(),
      groupMembersOf: new Map(),
      onGroupEdit: noop,
      onGroupApplyAndResolve: noop,
      onLocate: noop,
      onAcceptSuggestion: noop,
      onRejectSuggestion: noop,
      onFocusThread: noop,
      composerOpen: false,
      composerDraft: "",
      composerAnchored: false,
      onComposerDraftChange: noop,
      onPostComment: noop,
      onPostCommentSeen: noop,
      onCancelComposer: noop,
    } as never),
  );
}

describe("comment composer rail", () => {
  test("shows the multiline composer in an otherwise empty rail", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(CommentSidebar as never, {
        view: null,
        cards: [],
        activeId: null,
        seenIds: new Set<string>(),
        showSeen: false,
        unseenCount: 0,
        onToggleSeen: noop,
        repositionKey: 0,
        replyTarget: null,
        onResolveThread: noop,
        onDeleteComment: noop,
        onReply: noop,
        onReplyAndSeen: noop,
        onSuggestEdit: noop,
        onApplySuggestion: noop,
        onApplyAndResolveSuggestion: noop,
        onRejectSuggestionEdit: noop,
        applicableSuggestionIds: new Set<string>(),
        suggestionGroupOf: new Map(),
        groupMembersOf: new Map(),
        onGroupEdit: noop,
        onGroupApplyAndResolve: noop,
        onLocate: noop,
        onAcceptSuggestion: noop,
        onRejectSuggestion: noop,
        onFocusThread: noop,
        composerOpen: true,
        composerDraft: "first line\n\nsecond line",
        composerAnchored: true,
        onComposerDraftChange: noop,
        onPostComment: noop,
        onPostCommentSeen: noop,
        onCancelComposer: noop,
      } as never),
    );

    expect(html).toContain('aria-label="Comment on selection"');
    expect(html).toContain("first line\n\nsecond line");
    expect(html).not.toContain("No unseen comments.");
  });
});

describe("standalone addition rail cards", () => {
  test("keeps the full rich proposal in the document and renders a compact decision card", () => {
    const inner = "## Proposed section\n\n- First proposed item\n- *Formatted proposed item*";
    const html = renderSidebar([
      {
        kind: "suggestion",
        id: "addition-1",
        from: 0,
        to: inner.length + 6,
        standalone: true,
        suggestion: {
          id: "addition-1",
          type: "insert",
          from: 0,
          to: inner.length + 6,
          raw: `{++${inner}++}`,
          inner,
        },
        comments: [],
      } as SidebarCard,
    ]);

    expect(html).toContain("Proposed section");
    expect(html).toContain("Rendered in document");
    expect(html).toContain('aria-label="Accept suggestion"');
    expect(html).toContain('aria-label="Reject suggestion"');
    expect(html).not.toContain("First proposed item");
    expect(html).not.toContain("## Proposed section");
  });

  test("keeps an inline insertion's wording in its rail card", () => {
    const html = renderSidebar([
      {
        kind: "suggestion",
        id: "inline-1",
        from: 7,
        to: 24,
        standalone: false,
        suggestion: {
          id: "inline-1",
          type: "insert",
          from: 7,
          to: 24,
          raw: "{++new wording++}",
          inner: "new wording",
        },
        comments: [],
      } as SidebarCard,
    ]);

    expect(html).toContain("new wording");
    expect(html).not.toContain("Rendered in document");
  });

  test("shows the complete addition in the rail while raw source mode is active", () => {
    const inner = "## Proposed section\n\n- First proposed item";
    const html = renderSidebar([
      {
        kind: "suggestion",
        id: "addition-raw",
        from: 0,
        to: inner.length + 6,
        standalone: true,
        suggestion: {
          id: "addition-raw",
          type: "insert",
          from: 0,
          to: inner.length + 6,
          raw: `{++${inner}++}`,
          inner,
        },
        comments: [],
      } as SidebarCard,
    ], false);

    expect(html).toContain("## Proposed section");
    expect(html).toContain("First proposed item");
    expect(html).not.toContain("Rendered in document");
  });
});
