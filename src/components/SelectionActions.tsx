import { useEffect, useLayoutEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { EditorView } from "@codemirror/view";

interface SelectionRange {
  from: number;
  to: number;
}

interface SelectionActionsProps {
  view: EditorView | null;
  selection: SelectionRange | null;
  onAddComment: () => void;
  onMakeSuggestion: () => void;
}

interface CoordinateRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface ViewportBounds {
  top: number;
  bottom: number;
}

interface ToolbarPosition {
  left: number;
  top: number;
  placement: "above" | "below";
}

const TOOLBAR_EDGE = 132;
const TOOLBAR_GAP = 10;

export function selectionToolbarPosition(
  start: CoordinateRect,
  end: CoordinateRect,
  viewport: ViewportBounds,
  viewportWidth: number,
): ToolbarPosition | null {
  const selectionTop = Math.min(start.top, end.top);
  const selectionBottom = Math.max(start.bottom, end.bottom);
  if (selectionBottom < viewport.top || selectionTop > viewport.bottom) return null;

  const centre = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2;
  const maxLeft = Math.max(TOOLBAR_EDGE, viewportWidth - TOOLBAR_EDGE);
  const left = Math.min(maxLeft, Math.max(TOOLBAR_EDGE, centre));
  const above = selectionTop - TOOLBAR_GAP;
  if (above > viewport.top + 8) return { left, top: above, placement: "above" };
  return { left, top: selectionBottom + TOOLBAR_GAP, placement: "below" };
}

export default function SelectionActions({
  view,
  selection,
  onAddComment,
  onMakeSuggestion,
}: SelectionActionsProps) {
  const [position, setPosition] = useState<ToolbarPosition | null>(null);

  useLayoutEffect(() => {
    if (!view || !selection) {
      setPosition(null);
      return;
    }
    const start = view.coordsAtPos(selection.from, -1);
    const end = view.coordsAtPos(selection.to, 1);
    if (!start || !end) {
      setPosition(null);
      return;
    }
    const scroller = view.scrollDOM.getBoundingClientRect();
    setPosition(
      selectionToolbarPosition(start, end, scroller, window.innerWidth),
    );
  }, [view, selection]);

  useEffect(() => {
    if (!view || !selection) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const start = view.coordsAtPos(selection.from, -1);
      const end = view.coordsAtPos(selection.to, 1);
      if (!start || !end) {
        setPosition(null);
        return;
      }
      const scroller = view.scrollDOM.getBoundingClientRect();
      setPosition(selectionToolbarPosition(start, end, scroller, window.innerWidth));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    view.scrollDOM.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      view.scrollDOM.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [view, selection]);

  if (!position) return null;
  const keepSelection = (event: ReactMouseEvent) => event.preventDefault();

  return (
    <div
      role="toolbar"
      aria-label="Actions for selected text"
      className="fixed z-50 flex w-max max-w-[calc(100vw-1rem)] items-center gap-1 whitespace-nowrap rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] p-1 shadow-[0_5px_18px_rgba(0,0,0,0.16)]"
      style={{
        left: position.left,
        top: position.top,
        transform: position.placement === "above" ? "translate(-50%, -100%)" : "translateX(-50%)",
      }}
      onMouseDown={keepSelection}
    >
      <button
        type="button"
        onMouseDown={keepSelection}
        onClick={onAddComment}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--line)]"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--crit-comment)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        Add comment
      </button>
      <span className="h-5 w-px bg-[var(--line)]" aria-hidden="true" />
      <button
        type="button"
        onMouseDown={keepSelection}
        onClick={onMakeSuggestion}
        title="Ask the agent to propose an edit for this selection"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-[var(--crit-comment)] hover:bg-[var(--line)]"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        Make suggestion
      </button>
    </div>
  );
}

export type { SelectionActionsProps, SelectionRange };
