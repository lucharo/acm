// Navigation panel: token counts, a filter switcher, and a scrollable jump
// list. Purely presentational — App owns selection, filtering state, and every
// mutation; this module only renders and forwards clicks.
//
// Filters (FilterMode): all / comments / suggestions / unresolved. "Unresolved"
// is treated as comments-only: resolving removes a comment from the document, so
// every comment still present is by definition unresolved.
//
// "Suggestion" here follows the glossary umbrella: inline CriticMarkup tokens
// (isSuggestion) PLUS agent SUGGEST cards — comments whose id is in
// applicableSuggestionIds. Those cards count and filter as suggestions, never
// as comments (no double-counting); they stay in "unresolved" because a pending
// suggestion is still an open item.

import type {
  CritToken,
  SuggestionToken,
  CommentToken,
  FilterMode,
} from "../lib/types";
import { isSuggestion, isComment } from "../lib/types";
import { authorColor } from "./authorColor";

interface NavPanelProps {
  tokens: CritToken[];
  /** Ids of SUGGEST-card comments with a resolvable anchor (see
   *  applicableSuggestionIds in lib/criticmarkup) — tallied and filtered as
   *  suggestions, not comments. */
  applicableSuggestionIds: Set<string>;
  filter: FilterMode;
  onFilterChange: (f: FilterMode) => void;
  activeId: string | null;
  onSelect: (token: CritToken) => void;
  onAccept: (token: SuggestionToken) => void;
  onReject: (token: SuggestionToken) => void;
  onResolve: (token: CommentToken) => void;
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

function matchesFilter(
  token: CritToken,
  filter: FilterMode,
  suggestCardIds: Set<string>,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "comments":
      return isComment(token) && !suggestCardIds.has(token.id);
    case "suggestions":
      return isSuggestion(token) || suggestCardIds.has(token.id);
    case "unresolved":
      // Comments-only: every present comment is unresolved. SUGGEST cards stay
      // in — a pending suggestion is still an open item.
      return isComment(token);
  }
}

export default function NavPanel(props: NavPanelProps) {
  const {
    tokens,
    applicableSuggestionIds,
    filter,
    onFilterChange,
    activeId,
    onSelect,
    onAccept,
    onReject,
    onResolve,
  } = props;

  const suggestionCount = tokens.filter(
    (t) => isSuggestion(t) || applicableSuggestionIds.has(t.id),
  ).length;
  const commentCount = tokens.filter(
    (t) => isComment(t) && !applicableSuggestionIds.has(t.id),
  ).length;

  const visible = tokens.filter((t) => matchesFilter(t, filter, applicableSuggestionIds));

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
