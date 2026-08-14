import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { MOD } from "../lib/platform";

interface ReviewTextEditorProps {
  value: string;
  label: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  mobile?: boolean;
}

export function reviewEditKeyAction(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): "save" | "cancel" | null {
  if (event.key === "Escape") return "cancel";
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) return "save";
  return null;
}

export function closeReviewEditorAfterSuccessfulSave(
  save: () => boolean,
  close: () => void,
): boolean {
  const saved = save();
  if (saved) close();
  return saved;
}

export default function ReviewTextEditor({
  value,
  label,
  onChange,
  onSave,
  onCancel,
  mobile = false,
}: ReviewTextEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const action = reviewEditKeyAction(event);
    if (!action) return;
    event.preventDefault();
    (action === "save" ? onSave : onCancel)();
  };

  return (
    <div className="space-y-2" onClick={(event) => event.stopPropagation()}>
      <textarea
        ref={textareaRef}
        rows={mobile ? 4 : 3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label={label}
        className={[
          "block max-h-52 min-h-20 w-full resize-y rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2.5 py-2 leading-relaxed text-[var(--ink)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]",
          mobile ? "text-base" : "text-[13px]",
        ].join(" ")}
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[var(--line-strong)] px-2.5 py-1 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--line)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-[var(--panel)]"
        >
          Save <span className="text-[10px] font-normal opacity-70">{MOD}↵</span>
        </button>
      </div>
    </div>
  );
}

export type { ReviewTextEditorProps };
