// Floating table of contents — a Google-Docs-style document outline. Lists the
// markdown headings, indented by level; click one to jump to it. Purely
// presentational: App extracts the headings (with doc offsets) and owns the jump.

interface TocHeading {
  level: number;
  text: string;
  from: number; // document offset of the heading line
}

interface TocProps {
  headings: TocHeading[];
  activeFrom: number | null; // heading nearest the viewport top (highlighted)
  onJump: (from: number) => void;
  onClose: () => void;
}

export default function Toc({ headings, activeFrom, onJump, onClose }: TocProps) {
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6);

  return (
    <div className="fixed left-2 top-16 z-30 flex max-h-[calc(100vh-5rem)] w-60 flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow-2xl">
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">Outline</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded p-0.5 text-[var(--faint)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
          aria-label="Close outline"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {headings.length === 0 ? (
          <p className="px-3 py-2 text-xs italic text-[var(--faint)]">No headings yet.</p>
        ) : (
          <ul>
            {headings.map((h) => {
              const isActive = h.from === activeFrom;
              return (
                <li key={h.from}>
                  <button
                    type="button"
                    onClick={() => onJump(h.from)}
                    title={h.text}
                    style={{ paddingLeft: `${(h.level - minLevel) * 12 + 12}px` }}
                    className={[
                      "block w-full truncate py-1 pr-2 text-left text-[12px] leading-snug transition-colors",
                      h.level === minLevel ? "font-medium" : "",
                      isActive
                        ? "bg-[var(--line)] text-[var(--ink)]"
                        : "text-[var(--muted)] hover:bg-[var(--bg)] hover:text-[var(--ink)]",
                    ].join(" ")}
                  >
                    {h.text || "(untitled)"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export type { TocHeading };
