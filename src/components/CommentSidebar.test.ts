import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import CommentSidebar, { GroupPanel, GroupSurface, groupCountLabel, groupPanelPlacement } from "./CommentSidebar";
import type { GroupNoteMember } from "../lib/commentGroups";
import type { SuggestionGroupMember } from "../lib/criticmarkup";
import type { SidebarCard } from "../lib/types";

function renderSidebar(
  cards: SidebarCard[],
  richPreview = true,
  seenIds = new Set<string>(),
  showSeen = false,
  extra: Record<string, unknown> = {},
): string {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(CommentSidebar as never, {
      view: null,
      cards,
      richPreview,
      activeId: null,
      seenIds,
      showSeen,
      unseenCount: 0,
      onToggleSeen: noop,
      repositionKey: 0,
      replyTarget: null,
      onResolveThread: noop,
      onDeleteComment: noop,
      onReply: noop,
      onReplyAndSeen: noop,
      onSuggestEdit: noop,
      onAskAgent: noop,
      onApplySuggestion: noop,
      onApplyAndResolveSuggestion: noop,
      onRejectSuggestionEdit: noop,
      applicableSuggestionIds: new Set<string>(),
      groupOf: new Map(),
      groupNotesOf: new Map(),
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
      ...extra,
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
        onAskAgent: noop,
        onApplySuggestion: noop,
        onApplyAndResolveSuggestion: noop,
        onRejectSuggestionEdit: noop,
        applicableSuggestionIds: new Set<string>(),
        groupOf: new Map(),
        groupNotesOf: new Map(),
        groupMembersOf: new Map(),
        onGroupEdit: noop,
        onGroupApplyAndResolve: noop,
        onLocate: noop,
        onAcceptSuggestion: noop,
        onRejectSuggestion: noop,
        onFocusThread: noop,
        composerOpen: true,
        composerKind: "comment",
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

  test("renders the selected-text suggestion composer instead of a canned marker", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(CommentSidebar as never, {
        view: null,
        cards: [],
        richPreview: true,
        activeId: null,
        seenIds: new Set<string>(),
        showSeen: false,
        unseenCount: 0,
        onToggleSeen: noop,
        repositionKey: 0,
        replyTarget: null,
        onResolveThread: noop,
        onDeleteComment: noop,
        onEditComment: noop,
        onEditSuggestion: noop,
        onReply: noop,
        onReplyAndSeen: noop,
        onSuggestEdit: noop,
        onAskAgent: noop,
        onApplySuggestion: noop,
        onApplyAndResolveSuggestion: noop,
        onRejectSuggestionEdit: noop,
        applicableSuggestionIds: new Set<string>(),
        groupOf: new Map(),
        groupNotesOf: new Map(),
        groupMembersOf: new Map(),
        onGroupEdit: noop,
        onGroupApplyAndResolve: noop,
        onLocate: noop,
        onAcceptSuggestion: noop,
        onRejectSuggestion: noop,
        onFocusThread: noop,
        composerOpen: true,
        composerKind: "suggestion",
        composerDraft: "clearer wording",
        composerAnchored: true,
        onComposerDraftChange: noop,
        onPostComment: noop,
        onPostCommentSeen: noop,
        onCancelComposer: noop,
      } as never),
    );

    expect(html).toContain('aria-label="Suggested replacement"');
    expect(html).toContain("Create suggestion");
    expect(html).not.toContain("suggest edit");
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

describe("review-item edit affordances", () => {
  test("offers Edit for comments and editable native suggestions, but not deletions", () => {
    const commentHtml = renderSidebar([
      {
        kind: "comment",
        id: "comment-1",
        from: 0,
        to: 20,
        comments: [
          {
            id: "comment-1",
            type: "comment",
            from: 0,
            to: 20,
            raw: "{>>@claude: note<<}",
            author: "claude",
            body: "note",
          },
        ],
      },
    ]);
    const insertionHtml = renderSidebar([
      {
        kind: "suggestion",
        id: "insert-1",
        from: 0,
        to: 11,
        standalone: false,
        suggestion: {
          id: "insert-1",
          type: "insert",
          from: 0,
          to: 11,
          raw: "{++draft++}",
          inner: "draft",
        },
        comments: [],
      },
    ]);
    const deletionHtml = renderSidebar([
      {
        kind: "suggestion",
        id: "delete-1",
        from: 0,
        to: 15,
        standalone: false,
        suggestion: {
          id: "delete-1",
          type: "delete",
          from: 0,
          to: 15,
          raw: "{--remove me--}",
          inner: "remove me",
        },
        comments: [],
      },
    ]);

    expect(commentHtml).toContain('aria-label="Edit comment"');
    expect(commentHtml).toContain("focus-visible:opacity-100");
    expect(insertionHtml).toContain('aria-label="Edit suggestion"');
    expect(deletionHtml).not.toContain('aria-label="Edit suggestion"');
  });
});

describe("seen comment presentation", () => {
  test("recedes a seen thread without reducing the contrast of its contents", () => {
    const html = renderSidebar(
      [
        {
          kind: "comment",
          id: "comment-seen",
          from: 0,
          to: 20,
          comments: [
            {
              id: "comment-seen",
              type: "comment",
              from: 0,
              to: 20,
              raw: "{>>@claude: reviewed<<}",
              author: "claude",
              body: "reviewed",
            },
          ],
        },
      ],
      true,
      new Set(["comment-seen"]),
      true,
    );

    expect(html).not.toContain("opacity:0.45");
    expect(html).toContain("background-color:var(--bg)");
    expect(html).toContain("outline:1px solid var(--line)");
  });
});

function commentCard(id: string, body: string, author = "claude"): SidebarCard {
  const raw = `{>>@${author}: ${body}<<}`;
  return {
    kind: "comment",
    id,
    from: 0,
    to: raw.length,
    comments: [{ id, type: "comment", from: 0, to: raw.length, raw, author, body }],
  };
}

describe("comment body links (#68)", () => {
  test("renders bare and Markdown URLs as new-tab links and lets long strings wrap", () => {
    const html = renderSidebar([
      commentCard("c1", "Source (https://x.com/k/status/1). See [the thread](https://example.com/t)."),
    ]);

    expect(html).toContain(
      '<a href="https://x.com/k/status/1" target="_blank" rel="noopener noreferrer"',
    );
    expect(html).toContain('<a href="https://example.com/t" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain(">the thread</a>");
    expect(html).toContain("[overflow-wrap:anywhere]");
  });
});

describe("review groups with notes (#77) and the group panel (#67)", () => {
  const notes: GroupNoteMember[] = [1, 2, 3].map((n) => ({
    commentId: `note-${n}`,
    threadId: `note-${n}`,
    threadFrom: n * 100,
    threadTo: n * 100 + 40,
    anchorFrom: n * 100 + 3,
    anchorTo: n * 100 + 10,
    anchorText: `fact ${n}`,
    author: "claude",
    text: `Source ${n}.`,
  }));
  const edits: SuggestionGroupMember[] = [
    { commentId: "edit-1", from: 50, anchorFrom: 40, anchorTo: 43, anchorText: "teh", replacement: "the", isDelete: false },
  ];

  test("counts edits and notes in the chip label", () => {
    expect([
      groupCountLabel({ edits: 14, notes: 0 }),
      groupCountLabel({ edits: 0, notes: 1 }),
      groupCountLabel({ edits: 2, notes: 3 }),
    ]).toEqual(["14 edits", "1 note", "2 edits · 3 notes"]);
  });

  test("shows a grouped note without its tag and with the group chip", () => {
    const html = renderSidebar([commentCard("note-1", "NOTE[g:facts]: Source 1.")], true, new Set(), false, {
      groupOf: new Map([["note-1", { id: "facts", edits: 0, notes: 3 }]]),
      groupNotesOf: new Map([["facts", notes]]),
    });

    expect(html).toContain("Source 1.");
    expect(html).not.toContain("NOTE[g:facts]");
    expect(html).toContain("facts · 3 notes");
  });

  test("the panel lists edits and notes in document order with Apply all and Resolve all", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(GroupPanel, {
        group: { id: "facts", edits: 1, notes: 3 },
        members: edits,
        notes,
        mode: "panel",
        onMode: noop,
        onGroupEdit: noop,
        onGroupApplyAndResolve: noop,
        onGroupResolveNotes: noop,
        onLocate: noop,
        unticked: new Set<string>(),
        onToggle: noop,
        onToggleAll: noop,
      }),
    );
    const order = ["teh", "Source 1.", "Source 2.", "Source 3."].map((t) => html.indexOf(t));

    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    expect(html).toContain("Apply all 1");
    expect(html).toContain("Resolve all 3 notes");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("overflow-y-auto");
  });
});

describe("group panel beside its card, with ticked rows (#25)", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const STUBBED = ["window", "IS_REACT_ACT_ENVIRONMENT", "IS_REACT_NATIVE_TEST_ENVIRONMENT"];
  const saved = new Map<string, unknown>();
  let renderer: ReactTestRenderer | undefined;

  beforeAll(() => {
    for (const key of STUBBED) saved.set(key, globals[key]);
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    globals.IS_REACT_NATIVE_TEST_ENVIRONMENT = true; // silences the renderer's web deprecation notice
  });

  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    delete globals.window;
  });

  const edits: SuggestionGroupMember[] = [1, 2, 3].map((n) => ({
    commentId: `edit-${n}`,
    from: n * 100,
    anchorFrom: n * 100 - 20,
    anchorTo: n * 100 - 10,
    anchorText: `old ${n}`,
    replacement: `new ${n}`,
    isDelete: false,
  }));
  const notes: GroupNoteMember[] = [1, 2].map((n) => ({
    commentId: `note-${n}`,
    threadId: `note-${n}`,
    threadFrom: 1000 + n * 100,
    threadTo: 1000 + n * 100 + 40,
    anchorFrom: 1000 + n * 100 + 3,
    anchorTo: 1000 + n * 100 + 10,
    anchorText: `fact ${n}`,
    author: "claude",
    text: `Source ${n}.`,
  }));
  type Call = [string, ...unknown[]];

  function surfaceProps(calls: Call[]) {
    return {
      group: { id: "g", edits: 3, notes: 2 },
      members: edits,
      notes,
      mode: "popover" as const,
      onMode: (mode: unknown) => calls.push(["mode", mode]),
      onGroupEdit: (id: string, mode: string, unticked?: ReadonlySet<string>) =>
        calls.push(["edit", id, mode, unticked && [...unticked]]),
      onGroupApplyAndResolve: (id: string, unticked?: ReadonlySet<string>) =>
        calls.push(["apply-resolve", id, unticked && [...unticked]]),
      onGroupResolveNotes: (id: string, unticked?: ReadonlySet<string>) =>
        calls.push(["resolve-notes", id, unticked && [...unticked]]),
      onLocate: () => calls.push(["locate"]),
    };
  }
  const event = { stopPropagation() {}, preventDefault() {} };
  const text = (node: ReactTestInstance): string =>
    node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
  const button = (label: string) => {
    const found = renderer!.root.findAll((n) => n.type === "button" && text(n) === label);
    expect(found).toHaveLength(1);
    return found[0];
  };
  const checkbox = (id: string) => renderer!.root.find((n) => n.type === "input" && n.props.value === id);

  test("places the panel under the group link, or above it when the window is short below", () => {
    const viewport = { width: 1280, height: 800 };

    expect([
      groupPanelPlacement({ top: 200, bottom: 220, right: 1250 }, viewport),
      groupPanelPlacement({ top: 700, bottom: 720, right: 1250 }, viewport),
      groupPanelPlacement({ top: 250, bottom: 270, right: 1250 }, { width: 1280, height: 500 }),
      groupPanelPlacement({ top: -300, bottom: -280, right: 1250 }, viewport),
      groupPanelPlacement({ top: 200, bottom: 220, right: 200 }, viewport),
      groupPanelPlacement({ top: 200, bottom: 220, right: 350 }, { width: 360, height: 800 }),
    ]).toEqual([
      { top: 226, right: 30, width: 400, maxHeight: 558 },
      { bottom: 106, right: 30, width: 400, maxHeight: 678 },
      { top: 16, right: 30, width: 400, maxHeight: 468 },
      { top: 16, right: 30, width: 400, maxHeight: 768 },
      { top: 226, right: 864, width: 400, maxHeight: 558 },
      { top: 226, right: 16, width: 328, maxHeight: 558 },
    ]);
  });

  test("the panel opens at its card's group link instead of the window corner", () => {
    globals.window = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
    const anchor = { current: { getBoundingClientRect: () => ({ top: 200, bottom: 220, right: 1250 }) } };

    act(() => {
      renderer = create(
        createElement(GroupPanel, {
          ...surfaceProps([]),
          mode: "panel",
          unticked: new Set<string>(),
          onToggle: () => {},
          onToggleAll: () => {},
          anchor: anchor as never,
        }),
      );
    });
    const dialog = renderer!.root.findByProps({ role: "dialog" });

    expect(dialog.props.style).toEqual({ top: 226, right: 30, width: 400, maxHeight: 558 });
    expect(dialog.props.className).not.toContain("top-16");
  });

  test("every row has a checkbox, ticked unless unticked, and the buttons count the ticked rows", () => {
    const html = renderToStaticMarkup(
      createElement(GroupPanel, {
        ...surfaceProps([]),
        mode: "panel",
        unticked: new Set(["edit-2", "note-1"]),
        onToggle: () => {},
        onToggleAll: () => {},
      }),
    );
    const boxes = [...html.matchAll(/<input[^>]*value="([^"]+)"[^>]*>/g)].map((m) => [m[1], m[0].includes("checked")]);

    expect(boxes).toEqual([
      ["edit-1", true],
      ["edit-2", false],
      ["edit-3", true],
      ["note-1", false],
      ["note-2", true],
    ]);
    expect(
      ["Apply 2 of 3", "Apply &amp; resolve 2", "Reject 2", "Resolve 1 of 2 notes"].filter((label) =>
        html.includes(`>${label}</button>`),
      ),
    ).toEqual(["Apply 2 of 3", "Apply &amp; resolve 2", "Reject 2", "Resolve 1 of 2 notes"]);
  });

  test("with every edit unticked the edit buttons are disabled", () => {
    act(() => {
      renderer = create(
        createElement(GroupPanel, {
          ...surfaceProps([]),
          mode: "panel",
          unticked: new Set(["edit-1", "edit-2", "edit-3"]),
          onToggle: () => {},
          onToggleAll: () => {},
        }),
      );
    });

    expect(["Apply 0 of 3", "Apply & resolve 0", "Reject 0"].map((label) => button(label).props.disabled)).toEqual([
      true,
      true,
      true,
    ]);
  });

  test("unticking rows in the popover hands every button the unticked set", () => {
    const calls: Call[] = [];
    act(() => {
      renderer = create(createElement(GroupSurface, surfaceProps(calls)));
    });

    act(() => checkbox("edit-2").props.onChange(event));
    act(() => checkbox("note-1").props.onChange(event));
    act(() => button("Apply 2 of 3").props.onClick(event));
    act(() => button("Apply & resolve 2").props.onClick(event));
    act(() => button("Reject 2").props.onClick(event));
    act(() => button("Resolve 1 of 2 notes").props.onClick(event));

    expect(calls).toEqual([
      ["edit", "g", "accept", ["edit-2", "note-1"]],
      ["apply-resolve", "g", ["edit-2", "note-1"]],
      ["edit", "g", "reject", ["edit-2", "note-1"]],
      ["resolve-notes", "g", ["edit-2", "note-1"]],
    ]);
  });

  test("with every row ticked the buttons decide the whole group", () => {
    const calls: Call[] = [];
    act(() => {
      renderer = create(createElement(GroupSurface, surfaceProps(calls)));
    });

    act(() => button("Apply all 3").props.onClick(event));
    act(() => button("Resolve all 2 notes").props.onClick(event));

    expect(calls).toEqual([
      ["edit", "g", "accept", undefined],
      ["resolve-notes", "g", undefined],
    ]);
  });

  test("Untick all then ticking one row applies just that row", () => {
    const calls: Call[] = [];
    act(() => {
      renderer = create(createElement(GroupSurface, surfaceProps(calls)));
    });

    act(() => button("Untick all").props.onClick(event));
    act(() => checkbox("edit-3").props.onChange(event));
    act(() => button("Apply 1 of 3").props.onClick(event));

    expect(calls).toEqual([["edit", "g", "accept", ["edit-1", "edit-2", "note-1", "note-2"]]]);
  });

  test("an unticked note travels with Apply all, so an edit in its thread cannot remove it", () => {
    const calls: Call[] = [];
    act(() => {
      renderer = create(createElement(GroupSurface, surfaceProps(calls)));
    });

    act(() => checkbox("note-1").props.onChange(event));
    act(() => button("Apply all 3").props.onClick(event));

    expect(calls).toEqual([["edit", "g", "accept", ["note-1"]]]);
  });
});

describe("status pill arrows (#43)", () => {
  test("shows previous/next arrows around the open count when cards are in the rail", () => {
    const html = renderSidebar([commentCard("c1", "first"), commentCard("c2", "second")], true, new Set(), false, {
      unseenCount: 2,
    });

    expect(html).toContain('aria-label="Previous card (↑)"');
    expect(html).toContain("2 open");
    expect(html).toContain('aria-label="Next card (↓)"');
  });

  test("an empty rail shows the caught-up pill without arrows", () => {
    const html = renderSidebar([]);

    expect(html).toContain("all caught up");
    expect(html).not.toContain("Next card");
  });
});

describe("Ask agent (#76)", () => {
  test("offers Ask agent next to Suggest edit on a comment thread", () => {
    const html = renderSidebar([commentCard("c1", "wordy")], true, new Set(), false, {
      anchoredCardIds: new Set(["c1"]),
    });

    expect(html).toContain("Suggest edit");
    expect(html).toContain(">Ask agent</button>");
  });

  test("a point comment with no highlighted span does not offer Ask agent", () => {
    const html = renderSidebar([commentCard("c1", "wordy")], true, new Set(), false, {
      anchoredCardIds: new Set(),
    });

    expect(html).not.toContain("Ask agent");
  });

  test("shows the pending request instead of the button once asked", () => {
    const raw = "{>>@claude: wordy<<}{>>@You: please suggest an edit<<}";
    const html = renderSidebar([
      {
        kind: "comment",
        id: "c1",
        from: 0,
        to: raw.length,
        comments: [
          { id: "c1", type: "comment", from: 0, to: 20, raw: "", author: "claude", body: "wordy" },
          { id: "c2", type: "comment", from: 20, to: raw.length, raw: "", author: "You", body: "please suggest an edit" },
        ],
      },
    ], true, new Set(), false, { anchoredCardIds: new Set(["c1"]) });

    expect(html).toContain("Edit requested");
    expect(html).not.toContain(">Ask agent</button>");
  });
});

describe("long threads at rest (#79)", () => {
  function thread(bodies: string[]): SidebarCard {
    const comments = bodies.map((body, index) => {
      const raw = `{>>@claude: ${body}<<}`;
      return { id: `t${index}`, type: "comment" as const, from: index, to: index + raw.length, raw, author: "claude", body };
    });
    return { kind: "comment", id: "t0", from: 0, to: 10, comments };
  }

  test("a thread of more than three comments shows its first and last and counts the rest", () => {
    const html = renderSidebar([thread(["first", "second", "third", "fourth", "last"])]);

    expect(["first", "second", "third", "fourth", "last"].filter((body) => html.includes(`>${body}<`))).toEqual([
      "first",
      "last",
    ]);
    expect(html).toContain("3 more replies");
  });

  test("a thread of three comments shows them all", () => {
    const html = renderSidebar([thread(["first", "second", "last"])]);

    expect(html).not.toContain("more repl");
    expect(html).toContain(">second<");
  });
});
