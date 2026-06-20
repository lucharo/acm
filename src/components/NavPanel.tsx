// Navigation panel: token counts, a filter switcher, and a scrollable jump
// list. Purely presentational — App owns selection, filtering state, and every
// mutation; this module only renders and forwards clicks.
//
// Filters (FilterMode): all / comments / suggestions / unresolved. "Unresolved"
// is treated as comments-only: resolving removes a comment from the document, so
// every comment still present is by definition unresolved.

import type {
  CritToken,
  SuggestionToken,
  CommentToken,
  FilterMode,
} from "../lib/types";
import { isSuggestion, isComment } from "../lib/types";
import type { SuggestionGroupMember } from "../lib/criticmarkup";
import type { GroupView } from "../lib/viewSettings";
import { authorColor } from "./authorColor";

interface NavPanelProps {
  tokens: CritToken[];
  filter: FilterMode;
  onFilterChange: (f: FilterMode) => void;
  activeId: string | null;
  onSelect: (token: CritToken) => void;
  onAccept: (token: SuggestionToken) => void;
  onReject: (token: SuggestionToken) => void;
  onResolve: (token: CommentToken) => void;
  /** Which "see the group together" layout is active. Only "panel" renders the
   *  grouped section here; the other modes surface groups in the margin. */
  groupView: GroupView;
  /** groupId → its members ({old span, new wording}, document order). */
  groupMembersOf: Map<string, SuggestionGroupMember[]>;
  /** Accept/reject EVERY member of a group as one atomic edit. */
  onGroupEdit: (groupId: string, mode: "accept" | "reject") => void;
  /** Jump the editor to a document offset (a group member's comment). */
  onJumpToOffset: (from: number) => void;
}

const FILTERS: { value: FilterMode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "comments", label: "Comments" },
  { value: "suggestions", label: "Suggestions" },
  { value: "unresolved", label: "Unresolved" },
];

/** Color for a token's type marker dot. */
function markerColor(token: CritToken): string {
  switch (token.type) {
    case "insert":
      return "var(--crit-ins)";
    case "delete":
      return "var(--crit-del)";
    case "substitute":
      return "var(--crit-del)";
    case "highlight":
      return "var(--crit-hl-ink)";
    case "comment":
      return "var(--crit-comment)";
  }
}

/** Short single-line label for a token's type. */
function typeLabel(token: CritToken): string {
  switch (token.type) {
    case "insert":
      return "insert";
    case "delete":
      return "delete";
    case "substitute":
      return "sub";
    case "highlight":
      return "highlight";
    case "comment":
      return "comment";
  }
}

/** Human-readable preview text for a row. */
function preview(token: CritToken): string {
  switch (token.type) {
    case "insert":
    case "delete":
    case "highlight":
      return token.inner;
    case "substitute":
      return `${token.oldText} → ${token.newText}`;
    case "comment":
      return token.body;
  }
}

function matchesFilter(token: CritToken, filter: FilterMode): boolean {
  switch (filter) {
    case "all":
      return true;
    case "comments":
      return isComment(token);
    case "suggestions":
      return isSuggestion(token);
    case "unresolved":
      // Comments-only: every present comment is unresolved.
      return isComment(token);
  }
}

export default function NavPanel(props: NavPanelProps) {
  const {
    tokens,
    filter,
    onFilterChange,
    activeId,
    onSelect,
    onAccept,
    onReject,
    onResolve,
    groupView,
    groupMembersOf,
    onGroupEdit,
    onJumpToOffset,
  } = props;

  const suggestionCount = tokens.filter(isSuggestion).length;
  const commentCount = tokens.filter(isComment).length;

  const visible = tokens.filter((t) => matchesFilter(t, filter));

  // Suggestion groups, listed when groupView === "panel" (the other modes show
  // groups in the margin). Only on the All / Suggestions filters; ordered by where
  // each group's first member sits in the document.
  const showGroups =
    groupView === "panel" && groupMembersOf.size > 0 && (filter === "all" || filter === "suggestions");
  const groups = showGroups
    ? [...groupMembersOf.entries()].sort(
        (a, b) => (a[1][0]?.from ?? 0) - (b[1][0]?.from ?? 0),
      )
    : [];

  return (
    <div className="flex h-full w-full flex-col bg-[var(--panel)] text-[var(--ink)]">
      {/* Counts */}
      <div className="flex items-center gap-4 border-b border-[var(--line)] px-3 py-2">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-semibold tabular-nums">
            {suggestionCount}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
            suggestions
          </span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-semibold tabular-nums">
            {commentCount}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
            comments
          </span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-1 border-b border-[var(--line)] px-2 py-1.5">
        {FILTERS.map((f) => {
          const isOn = f.value === filter;
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => onFilterChange(f.value)}
              className={[
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                isOn
                  ? "bg-[var(--accent)] text-[var(--panel)]"
                  : "text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)]",
              ].join(" ")}
              aria-pressed={isOn}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Suggestion groups — the whole set, reviewable in one place + Apply-all
          (only in groupView "panel"; other modes surface groups in the margin). */}
      {groups.length > 0 ? (
        <div className="border-b border-[var(--line)] px-2 py-2">
          <div className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--faint)]">
            Suggestion groups
          </div>
          <div className="space-y-2">
            {groups.map(([id, members]) => (
              <div key={id} className="rounded-md border border-[var(--line)] p-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] font-medium text-[var(--ink)]" title={`Suggestion group “${id}”`}>
                    ⛓ {id} · {members.length} edits
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onGroupEdit(id, "accept")}
                      title={`Apply all ${members.length} edits in this group (one undo)`}
                      className="rounded bg-[var(--crit-ins)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--panel)]"
                    >
                      Apply all
                    </button>
                    <button
                      type="button"
                      onClick={() => onGroupEdit(id, "reject")}
                      title="Reject all edits in this group (one undo)"
                      className="rounded border border-[var(--line-strong)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--crit-del)]"
                    >
                      Reject
                    </button>
                  </div>
                </div>
                <ul className="space-y-0.5">
                  {members.map((m, i) => (
                    <li key={m.commentId}>
                      <button
                        type="button"
                        onClick={() => onJumpToOffset(m.from)}
                        title="Jump to this edit"
                        className="flex w-full gap-1.5 rounded px-1 py-0.5 text-left text-[12px] leading-snug hover:bg-[var(--bg)]"
                      >
                        <span className="shrink-0 tabular-nums text-[var(--faint)]">{i + 1}</span>
                        <span className="min-w-0 truncate">
                          {m.anchorText ? (
                            <>
                              <span className="text-[var(--crit-del)] line-through">{m.anchorText}</span>
                              <span className="px-1 text-[var(--faint)]">→</span>
                            </>
                          ) : null}
                          {m.isDelete ? (
                            <span className="italic text-[var(--crit-del)]">(delete)</span>
                          ) : (
                            <span className="text-[var(--crit-ins)]">{m.replacement}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Jump list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="px-3 pt-4 text-xs italic text-[var(--faint)]">
            Nothing to show.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {visible.map((token) => {
              const isActive = token.id === activeId;
              return (
                <li key={token.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(token)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(token);
                      }
                    }}
                    className={[
                      "flex cursor-pointer items-start gap-2 px-3 py-2 text-left transition-colors",
                      isActive
                        ? "bg-[var(--line)]"
                        : "hover:bg-[var(--bg)]",
                    ].join(" ")}
                  >
                    {/* type marker */}
                    <span
                      className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: markerColor(token) }}
                      title={typeLabel(token)}
                      aria-hidden="true"
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] uppercase tracking-wide text-[var(--faint)]">
                          {typeLabel(token)}
                        </span>
                        {isComment(token) && (
                          <span
                            className="truncate text-[10px] font-semibold uppercase tracking-wide"
                            style={{ color: authorColor(token.author) }}
                          >
                            {token.author ?? "anonymous"}
                          </span>
                        )}
                      </div>
                      <p className="truncate text-[13px] leading-snug text-[var(--ink)]">
                        {preview(token)}
                      </p>
                    </div>

                    {/* inline controls */}
                    <div className="flex shrink-0 items-center gap-0.5">
                      {isSuggestion(token) && (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onAccept(token);
                            }}
                            className="rounded px-1 py-0.5 text-xs text-[var(--crit-ins)] hover:bg-[var(--crit-ins-bg)]"
                            title="Accept"
                          >
                            ✓
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onReject(token);
                            }}
                            className="rounded px-1 py-0.5 text-xs text-[var(--crit-del)] hover:bg-[var(--crit-del-bg)]"
                            title="Reject"
                          >
                            ✗
                          </button>
                        </>
                      )}
                      {isComment(token) && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onResolve(token);
                          }}
                          className="rounded px-1 py-0.5 text-[10px] font-medium text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
                          title="Resolve comment"
                        >
                          ✓
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export type { NavPanelProps };
