// ── Shared contract for Agent CriticMarkup (ACM) ──────────────────────────────
// Imported by the editor, review surfaces, the sync layer, and the server.
// This file is the single source of truth for the data shapes that cross module
// boundaries. Do not redefine these types elsewhere.

/** The five CriticMarkup constructs ACM understands. */
export type CritType = "insert" | "delete" | "substitute" | "highlight" | "comment";

export interface CritTokenBase {
  /**
   * Unique id within a single `scanTokens` pass, CONTENT-DERIVED (hash of the
   * raw markup + an occurrence index for duplicates) — so a token's id survives
   * unrelated edits elsewhere in the document. Editing the construct itself
   * changes its id (its card legitimately changes identity). Safe to use as a
   * React key even when two tokens share an offset (overlapping/stacked anchors
   * — the real doc has 32 such spots). Opaque: never parse or order by it.
   */
  id: string;
  type: CritType;
  /** Absolute start offset in the document, at the opening brace `{`. */
  from: number;
  /** Absolute end offset (exclusive), just past the closing brace `}`. */
  to: number;
  /** The full raw markup exactly as it appears in the document, e.g. `{++hi++}`. */
  raw: string;
}

/** `{++inserted++}` — a suggested addition (rendered green). */
export interface InsertToken extends CritTokenBase {
  type: "insert";
  /** The text between the delimiters. */
  inner: string;
}

/** `{--deleted--}` — a suggested deletion (rendered red, struck through). */
export interface DeleteToken extends CritTokenBase {
  type: "delete";
  inner: string;
}

/** `{~~old~>new~~}` — a substitution (old struck, new green). */
export interface SubstituteToken extends CritTokenBase {
  type: "substitute";
  oldText: string;
  newText: string;
}

/** `{==highlight==}` — a highlight (rendered yellow). Not a suggestion. */
export interface HighlightToken extends CritTokenBase {
  type: "highlight";
  inner: string;
}

/** `{>>comment<<}` or `{>>@author: comment<<}` — a margin-bubble comment. */
export interface CommentToken extends CritTokenBase {
  type: "comment";
  /** Author parsed from a leading `@name:` prefix, else null. */
  author: string | null;
  /** Comment text with any `@author:` prefix stripped. */
  body: string;
}

export type CritToken =
  | InsertToken
  | DeleteToken
  | SubstituteToken
  | HighlightToken
  | CommentToken;

/** Tokens that carry inline accept (✓) / reject (✗) controls. */
export type SuggestionToken = InsertToken | DeleteToken | SubstituteToken;

export function isSuggestion(t: CritToken): t is SuggestionToken {
  return t.type === "insert" || t.type === "delete" || t.type === "substitute";
}
export function isComment(t: CritToken): t is CommentToken {
  return t.type === "comment";
}
export function isHighlight(t: CritToken): t is HighlightToken {
  return t.type === "highlight";
}

/**
 * A run of comments sharing an anchor — rendered as one threaded card. CriticMarkup
 * has no native reply field, so a "thread" is comments that sit adjacently in the
 * text (separated only by whitespace), e.g. `{>>@a: ..<<}{>>@b: ..<<}`. The first
 * comment is the root; the rest are replies.
 */
export interface CommentThread {
  /** Thread id = the root comment's id. */
  id: string;
  /** Anchor offset (root comment's `from`) — where the bubble connects in the text. */
  from: number;
  /** End offset (last comment's `to`) — replies append here. */
  to: number;
  comments: CommentToken[];
}

/**
 * A card in the right margin — either a comment thread OR a suggestion (with any
 * comments adjacent to it as its replies, so suggestions can spawn conversations).
 * Both carry `id`/`from`/`to`/`comments` so the sidebar's positioning is agnostic to
 * kind; only the card's inner rendering differs.
 */
export type SidebarCard =
  | { kind: "comment"; id: string; from: number; to: number; comments: CommentToken[] }
  | {
      kind: "suggestion";
      id: string;
      from: number;
      to: number;
      suggestion: SuggestionToken;
      /** Whole-line insertion already rendered as a rich block in the document. */
      standalone: boolean;
      comments: CommentToken[]; // replies adjacent to the suggestion (may be empty)
    };

/** The document as held on disk + a monotonic version stamped by the server. */
export interface DocState {
  content: string;
  version: number;
  /** Unique identity for this server lifetime; versions restart from zero per epoch. */
  serverEpoch: string;
  /** Resolved path identifying the document served by this ACM instance. */
  path: string;
}

/** Agent wake status (#31): listeners attached, threads waiting on the agent. */
export interface AgentStatus {
  listening: number;
  waiting: { comments: number; editRequests: number };
}

/** Messages pushed from the Bun server to the browser over the WebSocket.
 *  State-based: every push carries the full document snapshot + version. */
export type ServerMessage =
  | {
      type: "update";
      content: string;
      version: number;
      serverEpoch: string;
    }
  | ({ type: "agent" } & AgentStatus);

/** Severity of a bottom-right toast (Toast.tsx / imageInsert.ts / App). */
export type ToastKind = "info" | "error";
