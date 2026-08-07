import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MobileCommentSheet, {
  mobileReviewEntryLabel,
  seenToggleLabel,
} from "./MobileCommentSheet";
import type { SidebarCard } from "../lib/types";

describe("mobile review state labels", () => {
  test("the seen toggle describes the action it will perform", () => {
    expect(seenToggleLabel(false)).toBe("Mark done");
    expect(seenToggleLabel(true)).toBe("Mark unseen");
  });

  test("the entry button still exposes seen comments allowed by the filter", () => {
    expect(mobileReviewEntryLabel(2, 1)).toBe("1 open");
    expect(mobileReviewEntryLabel(1, 0)).toBe("1 shown");
    expect(mobileReviewEntryLabel(0, 0)).toBeNull();
  });

  test("native suggestions do not expose the comment-thread Resolve action", () => {
    const active: SidebarCard = {
      kind: "suggestion",
      id: "insert-1",
      from: 0,
      to: 12,
      standalone: false,
      suggestion: {
        id: "insert-1",
        type: "insert",
        from: 0,
        to: 12,
        raw: "{++added++}",
        inner: "added",
      },
      comments: [],
    };
    const noop = () => {};

    const html = renderToStaticMarkup(
      createElement(MobileCommentSheet, {
        active,
        activeSeen: false,
        unseenCount: 0,
        richPreview: true,
        nextOpen: null,
        onClose: noop,
        onGoTo: noop,
        onReply: noop,
        onReplyAndSeen: noop,
        onResolveThread: noop,
        onSuggestEdit: noop,
        onToggleSeen: noop,
        onApplySuggestion: noop,
        onApplyAndResolveSuggestion: noop,
        onRejectSuggestionEdit: noop,
        applicableSuggestionIds: new Set<string>(),
        onAcceptSuggestion: noop,
        onRejectSuggestion: noop,
      }),
    );

    expect(html).not.toContain(">Resolve</button>");
    expect(html).toContain("Accept");
    expect(html).toContain("Reject");
  });

  test("rich standalone additions stay in the document instead of duplicating raw Markdown", () => {
    const inner = "## Proposed section\n\n- **First** proposed item";
    const active: SidebarCard = {
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
    };
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(MobileCommentSheet, {
        active,
        activeSeen: false,
        unseenCount: 1,
        richPreview: true,
        nextOpen: null,
        onClose: noop,
        onGoTo: noop,
        onReply: noop,
        onReplyAndSeen: noop,
        onResolveThread: noop,
        onSuggestEdit: noop,
        onToggleSeen: noop,
        onApplySuggestion: noop,
        onApplyAndResolveSuggestion: noop,
        onRejectSuggestionEdit: noop,
        applicableSuggestionIds: new Set<string>(),
        onAcceptSuggestion: noop,
        onRejectSuggestion: noop,
      }),
    );

    expect(html).toContain("Proposed section");
    expect(html).toContain("Rendered in document");
    expect(html).toContain("disabled:bg-transparent");
    expect(html).not.toContain("**First** proposed item");
  });

  test("raw mode keeps standalone addition source inspectable in the sheet", () => {
    const inner = "## Proposed section\n\n- **First** proposed item";
    const active: SidebarCard = {
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
    };
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(MobileCommentSheet, {
        active,
        activeSeen: false,
        unseenCount: 1,
        richPreview: false,
        nextOpen: null,
        onClose: noop,
        onGoTo: noop,
        onReply: noop,
        onReplyAndSeen: noop,
        onResolveThread: noop,
        onSuggestEdit: noop,
        onToggleSeen: noop,
        onApplySuggestion: noop,
        onApplyAndResolveSuggestion: noop,
        onRejectSuggestionEdit: noop,
        applicableSuggestionIds: new Set<string>(),
        onAcceptSuggestion: noop,
        onRejectSuggestion: noop,
      }),
    );

    expect(html).toContain("**First** proposed item");
    expect(html).not.toContain("Rendered in document");
  });
});
