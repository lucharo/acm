// The formatting toolbar in the title bar (#79, look C): undo/redo, paragraph
// style, bold, italic, link, lists, and the review actions (comment, suggest).
// Every button edits the Markdown buffer through the same commands as the keyboard.
import type { MouseEvent as ReactMouseEvent } from "react";
import type { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import {
  Bold,
  Italic,
  Link,
  List,
  ListOrdered,
  MessageSquarePlus,
  PencilLine,
  Redo2,
  Undo2,
} from "lucide-react";
import { toggleEmphasis, toggleStrong } from "../editor/formatting";
import { MOD, ALT } from "../lib/platform";
import { currentBlockStyle, insertLink, setBlockStyle, toggleList } from "../editor/blockFormat";
import type { BlockStyle } from "../editor/blockFormat";

interface FormatToolbarProps {
  view: EditorView | null;
  /** Bumps whenever the selection moves, so the style menu re-reads the line. */
  selectionTick: unknown;
  hasSelection: boolean;
  onAddComment: () => void;
  onMakeSuggestion: () => void;
}

const STYLES: Array<{ value: BlockStyle; label: string }> = [
  { value: 0, label: "Normal text" },
  { value: 1, label: "Heading 1" },
  { value: 2, label: "Heading 2" },
  { value: 3, label: "Heading 3" },
];

export default function FormatToolbar(props: FormatToolbarProps) {
  const { view, hasSelection, onAddComment, onMakeSuggestion } = props;
  const keep = (event: ReactMouseEvent) => event.preventDefault(); // keep the editor selection
  const run = (fn: (v: EditorView) => unknown) => () => {
    if (!view) return;
    fn(view);
    view.focus();
  };
  const style = view ? currentBlockStyle(view.state) : 0;
  const button =
    "flex h-8 w-8 items-center justify-center rounded text-[var(--ink)] hover:bg-[var(--line)] disabled:opacity-40 disabled:hover:bg-transparent";
  const divider = <span className="mx-1 h-5 w-px bg-[var(--line-strong)]" aria-hidden="true" />;

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex items-center gap-0.5"
    >
      <button type="button" className={button} onMouseDown={keep} onClick={run(undo)} title={`Undo (${MOD}Z)`} aria-label="Undo">
        <Undo2 size={16} strokeWidth={1.8} />
      </button>
      <button type="button" className={button} onMouseDown={keep} onClick={run(redo)} title={`Redo (${MOD}⇧Z)`} aria-label="Redo">
        <Redo2 size={16} strokeWidth={1.8} />
      </button>
      {divider}
      <select
        aria-label="Paragraph style"
        value={style}
        onChange={(event) => view && setBlockStyle(view, Number(event.target.value) as BlockStyle)}
        className="h-8 rounded bg-transparent px-1.5 text-[13px] text-[var(--ink)] outline-none hover:bg-[var(--line)]"
      >
        {STYLES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {divider}
      <button type="button" className={button} onMouseDown={keep} onClick={run(toggleStrong)} title={`Bold (${MOD}B)`} aria-label="Bold">
        <Bold size={16} strokeWidth={2.2} />
      </button>
      <button type="button" className={button} onMouseDown={keep} onClick={run(toggleEmphasis)} title={`Italic (${MOD}I)`} aria-label="Italic">
        <Italic size={16} strokeWidth={1.8} />
      </button>
      <button type="button" className={button} onMouseDown={keep} onClick={run(insertLink)} title="Insert link" aria-label="Insert link">
        <Link size={16} strokeWidth={1.8} />
      </button>
      {divider}
      <button type="button" className={button} onMouseDown={keep} onClick={run((v) => toggleList(v, "bullet"))} title="Bulleted list" aria-label="Bulleted list">
        <List size={17} strokeWidth={1.8} />
      </button>
      <button type="button" className={button} onMouseDown={keep} onClick={run((v) => toggleList(v, "number"))} title="Numbered list" aria-label="Numbered list">
        <ListOrdered size={17} strokeWidth={1.8} />
      </button>
      {divider}
      <button
        type="button"
        className={button}
        onMouseDown={keep}
        onClick={onAddComment}
        disabled={!hasSelection}
        title={`Add comment (${MOD}${ALT}M)`}
        aria-label="Add comment"
      >
        <MessageSquarePlus size={17} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className={button}
        onMouseDown={keep}
        onClick={onMakeSuggestion}
        disabled={!hasSelection}
        title={`Suggest replacement (${MOD}${ALT}S)`}
        aria-label="Suggest replacement"
      >
        <PencilLine size={17} strokeWidth={1.8} />
      </button>
    </div>
  );
}
