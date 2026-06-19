// ── App header: nav/outline toggles, comment composer, status, settings menu ──
// Purely presentational — every action and all state arrive as props from the
// Workspace; the only local state is whether the settings menu is open.

import { useState } from "react";
import type { FormEvent } from "react";
import { MOD, handleCommentKey } from "./CommentSidebar";
import type { SaveState } from "../client/useDocSync";
import { FONT_STACKS, FONT_LABELS } from "../lib/viewSettings";
import type { Font, Theme, SpellVariant, ViewSettings } from "../lib/viewSettings";

export interface HeaderProps {
  connected: boolean;
  saveState: SaveState;
  lastSavedAt: number | null;
  wordCount: number;
  canComment: boolean;
  composing: boolean;
  composerAnchored: boolean;
  onWrap: () => void;
  draft: string;
  onDraftChange: (v: string) => void;
  onOpenComposer: () => void;
  onPostComment: () => void;
  /** Post the comment AND mark it seen — the "suggest edits & dismiss" flow (⌘⇧↵). */
  onPostCommentSeen: () => void;
  /** One-click: post a canned "suggest edit" comment on the selection + mark it seen. */
  onSuggestEdit: () => void;
  onCancelComposer: () => void;
  navOpen: boolean;
  onToggleNav: () => void;
  tocOpen: boolean;
  onToggleToc: () => void;
  settings: ViewSettings;
  onChangeSettings: (patch: Partial<ViewSettings>) => void;
  /** Settings menu open-state is lifted to the Workspace so ⌘, can toggle it. */
  settingsOpen: boolean;
  onSetSettingsOpen: (open: boolean) => void;
  /** Open the keyboard-shortcuts cheat sheet. */
  onShowShortcuts: () => void;
  /** The user's personal spelling dictionary + add/remove (Spelling tab). */
  dictionary: string[];
  onAddWord: (word: string) => void;
  onRemoveWord: (word: string) => void;
}

const iconBtn =
  "flex h-7 w-7 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)]";

export default function Header(props: HeaderProps) {
  const {
    connected,
    saveState,
    lastSavedAt,
    wordCount,
    canComment,
    composing,
    composerAnchored,
    onWrap,
    draft,
    onDraftChange,
    onOpenComposer,
    onPostComment,
    onPostCommentSeen,
    onSuggestEdit,
    onCancelComposer,
    navOpen,
    onToggleNav,
    tocOpen,
    onToggleToc,
    settings,
    onChangeSettings,
    settingsOpen,
    onSetSettingsOpen,
    onShowShortcuts,
    dictionary,
    onAddWord,
    onRemoveWord,
  } = props;

  // settingsOpen is lifted to the Workspace (prop) so ⌘, can toggle it; only the
  // Display|Spelling tab choice is local.
  const [settingsTab, setSettingsTab] = useState<"display" | "spelling">("display");

  return (
    <header className="relative flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--line)] bg-[var(--panel)] px-3 py-1.5">
      {/* Overview-panel toggle — hidden on phones: the overview/comment column is a
          wide side panel that can't fit a narrow screen (the comment sidebar already
          auto-hides under ~800px), and the outline (next button) is the mobile nav. */}
      <button
        type="button"
        onClick={onToggleNav}
        className={`${iconBtn} hidden sm:flex ${navOpen ? "bg-[var(--line)] text-[var(--ink)]" : ""}`}
        title={navOpen ? "Hide overview" : "Show overview"}
        aria-pressed={navOpen}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>

      {/* Outline (table of contents) toggle */}
      <button
        type="button"
        onClick={onToggleToc}
        className={`${iconBtn} ${tocOpen ? "bg-[var(--line)] text-[var(--ink)]" : ""}`}
        title={tocOpen ? "Hide outline" : "Show outline"}
        aria-pressed={tocOpen}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <line x1="3" y1="4" x2="13" y2="4" />
          <line x1="5" y1="8" x2="13" y2="8" />
          <line x1="7" y1="12" x2="13" y2="12" />
        </svg>
      </button>

      <img src="/logo.png" alt="" className="h-5 w-5 shrink-0 rounded-[4px]" />
      <span className="text-[13px] font-semibold tracking-tight">
        ACM <span className="hidden text-[var(--faint)] sm:inline">· Agent CriticMarkup</span>
      </span>

      <div className="ml-auto flex flex-wrap items-center justify-end gap-2 gap-y-1">
        {composing ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5 gap-y-1">
            <textarea
              autoFocus
              rows={1}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => handleCommentKey(e, onPostComment, onPostCommentSeen, onCancelComposer)}
              placeholder="Comment on selection…  (⇧↵ for a new line)"
              className="block max-h-32 w-44 resize-none overflow-y-auto rounded border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-1 text-[13px] leading-relaxed text-[var(--ink)] outline-none [field-sizing:content] focus:border-[var(--accent)] sm:w-60"
            />
            {!composerAnchored && (
              /* The selection can't be wrapped as a {==span==} (it cuts markup or
                 crosses a paragraph) — disclose the point fallback instead of
                 silently degrading. */
              <span
                className="max-w-24 text-[10px] italic leading-tight text-[var(--muted)]"
                title="This selection crosses markup or a paragraph break, so the comment will attach at its end point instead of anchoring the span."
              >
                attaches at a point — selection can't anchor
              </span>
            )}
            <button
              type="button"
              onClick={onPostComment}
              className="flex items-center gap-1.5 rounded bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-[var(--panel)]"
            >
              Post <span className="text-[10px] font-normal opacity-70">{MOD}↵</span>
            </button>
            <button
              type="button"
              onClick={onPostCommentSeen}
              title="Post and mark it seen"
              className="flex items-center gap-1.5 rounded border border-[var(--line-strong)] px-2 py-1 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--line)]"
            >
              &amp; seen <span className="text-[10px] font-normal text-[var(--faint)]">{MOD}⇧↵</span>
            </button>
            <button
              type="button"
              onClick={onCancelComposer}
              className="rounded px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--line)]"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onOpenComposer}
            disabled={!canComment}
            title={canComment ? "Comment on selection" : "Select text to comment"}
            className="rounded border border-[var(--line-strong)] px-2.5 py-1 text-[12px] font-medium text-[var(--ink)] enabled:hover:bg-[var(--line)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add comment
          </button>
        )}
        {/* One-click hand-off: tag the selection with a "suggest edit" comment for the
            agent + mark it seen. Only when there's a selection and not mid-compose. */}
        {!composing && canComment ? (
          <button
            type="button"
            onClick={onSuggestEdit}
            title="Ask the agent for an edit on this selection — posts “suggest edit” and marks it seen"
            className="flex items-center gap-1 rounded border border-[var(--line-strong)] px-2.5 py-1 text-[12px] font-medium text-[var(--crit-comment)] hover:bg-[var(--line)]"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            Suggest edit
          </button>
        ) : null}

        <span className="hidden text-[11px] tabular-nums text-[var(--faint)] sm:inline" title="Word count (accepted prose)">
          {wordCount.toLocaleString()} words
        </span>

        <SaveBadge state={saveState} lastSavedAt={lastSavedAt} />

        <span
          className="hidden items-center gap-1.5 text-[11px] text-[var(--muted)] sm:flex"
          title={connected ? "Live — watching the file" : "Disconnected"}
        >
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: connected ? "var(--crit-ins)" : "var(--crit-del)" }}
          />
          {connected ? "live" : "offline"}
        </span>

        {/* Settings (a proper cog) */}
        <button
          type="button"
          onClick={() => onSetSettingsOpen(!settingsOpen)}
          className={`${iconBtn} ${settingsOpen ? "bg-[var(--line)] text-[var(--ink)]" : ""}`}
          title={`Settings (${MOD},)`}
          aria-haspopup="menu"
          aria-expanded={settingsOpen}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>

        {settingsOpen ? (
          <>
            <div className="fixed inset-0 z-20" onClick={() => onSetSettingsOpen(false)} />
            <div className="absolute right-3 top-11 z-30 w-60 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1.5 shadow-lg">
              {/* Display | Spelling tabs — keeps the (now busy) panel scannable and
                  gives the dictionary its own home, as requested. */}
              <div className="mb-1.5 flex gap-1 rounded-md bg-[var(--line)] p-0.5">
                {(["display", "spelling"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setSettingsTab(t)}
                    className={`flex-1 rounded px-2 py-1 text-[12px] font-medium capitalize transition-colors ${
                      settingsTab === t
                        ? "bg-[var(--panel)] text-[var(--ink)] shadow-sm"
                        : "text-[var(--muted)] hover:text-[var(--ink)]"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {settingsTab === "display" ? (
              <>
              <FontPicker value={settings.font} onChange={(font) => onChangeSettings({ font })} />
              <Segmented<Theme>
                label="Theme"
                value={settings.theme}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "system", label: "System" },
                ]}
                onChange={(theme) => onChangeSettings({ theme })}
              />
              <div className="my-1 border-t border-[var(--line)]" />
              <div className="px-2 py-1.5">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--faint)]">
                  Your name (on comments you add)
                </div>
                <input
                  value={settings.author}
                  onChange={(e) => onChangeSettings({ author: e.target.value })}
                  placeholder="You"
                  className="w-full rounded-md border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                />
              </div>
              <div className="my-1 border-t border-[var(--line)]" />
              <SettingRow
                label="Page view"
                checked={settings.page}
                onToggle={() => onChangeSettings({ page: !settings.page })}
              />
              <SettingRow
                label="Line numbers"
                checked={settings.lineNumbers}
                onToggle={() => onChangeSettings({ lineNumbers: !settings.lineNumbers })}
              />
              <SettingRow
                label="Bionic reading"
                checked={settings.bionic}
                onToggle={() => onChangeSettings({ bionic: !settings.bionic })}
              />
              <SettingRow
                label="A4 page breaks"
                checked={settings.pageBreaks}
                onToggle={() => onChangeSettings({ pageBreaks: !settings.pageBreaks })}
              />
              <SettingRow
                label="Show seen comments"
                checked={settings.showSeen}
                onToggle={() => onChangeSettings({ showSeen: !settings.showSeen })}
              />
              <SettingRow label="Overview panel" checked={navOpen} onToggle={onToggleNav} />
              <div className="my-1 border-t border-[var(--line)]" />
              <button
                type="button"
                onClick={() => {
                  onSetSettingsOpen(false);
                  onWrap();
                }}
                title="Reflow prose to 88 columns. Markup-safe (never splits a comment or suggestion) and undoable. Also in the ⌘K palette, or `acm wrap` from the shell."
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--ink)] hover:bg-[var(--line)]"
              >
                Hard-wrap prose <span className="text-[11px] text-[var(--faint)]">88 cols · ⌘K</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSetSettingsOpen(false);
                  onShowShortcuts();
                }}
                title="Show the keyboard shortcuts (formatting, navigation, comments, review)."
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--ink)] hover:bg-[var(--line)]"
              >
                Keyboard shortcuts <span className="text-[11px] text-[var(--faint)]">{MOD}/</span>
              </button>
              <div className="my-1 border-t border-[var(--line)]" />
              <div className="px-2 py-1.5">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--faint)]">
                  Agent-review skill
                </div>
                <p className="text-[11px] leading-snug text-[var(--muted)]">
                  Run <code className="rounded bg-[var(--line)] px-1 text-[var(--ink)]">acm skill</code> to
                  install, then edit{" "}
                  <code className="rounded bg-[var(--line)] px-1 text-[var(--ink)]">~/.agents/skills/acm-review/SKILL.md</code>{" "}
                  to customize how agents review.
                </p>
              </div>
              </>
              ) : (
                <SpellingTab
                  settings={settings}
                  onChangeSettings={onChangeSettings}
                  dictionary={dictionary}
                  onAddWord={onAddWord}
                  onRemoveWord={onRemoveWord}
                />
              )}
            </div>
          </>
        ) : null}
      </div>
    </header>
  );
}

/** A labelled row of mutually-exclusive options (font, theme, …). */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; style?: React.CSSProperties }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="px-2 py-1.5">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--faint)]">
        {label}
      </div>
      <div className="flex gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded px-2 py-1 text-[13px] transition-colors ${
              value === o.value
                ? "bg-[var(--accent)] text-[var(--panel)]"
                : "text-[var(--muted)] hover:bg-[var(--line)]"
            }`}
            style={o.style}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function FontPicker({ value, onChange }: { value: Font; onChange: (f: Font) => void }) {
  return (
    <Segmented<Font>
      label="Document font"
      value={value}
      options={(["serif", "sans", "mono"] as Font[]).map((f) => ({
        value: f,
        label: FONT_LABELS[f],
        style: { fontFamily: FONT_STACKS[f] },
      }))}
      onChange={onChange}
    />
  );
}

function SettingRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded px-2 py-1.5 text-[13px] text-[var(--ink)] hover:bg-[var(--line)]"
      role="menuitemcheckbox"
      aria-checked={checked}
    >
      <span>{label}</span>
      <span
        className={`relative h-4 w-7 rounded-full transition-colors ${
          checked ? "bg-[var(--crit-ins)]" : "bg-[var(--line-strong)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            checked ? "left-3.5" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

/** The Spelling settings tab: the on/off toggle + a manager for the personal
 *  dictionary (the words the user has taught the spellchecker). */
function SpellingTab({
  settings,
  onChangeSettings,
  dictionary,
  onAddWord,
  onRemoveWord,
}: {
  settings: ViewSettings;
  onChangeSettings: (patch: Partial<ViewSettings>) => void;
  dictionary: string[];
  onAddWord: (word: string) => void;
  onRemoveWord: (word: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const w = draft.trim();
    if (!w) return;
    onAddWord(w);
    setDraft("");
  };
  return (
    <div>
      <SettingRow
        label="Spell check"
        checked={settings.spellcheck}
        onToggle={() => onChangeSettings({ spellcheck: !settings.spellcheck })}
      />
      <p className="px-2 pb-1.5 text-[11px] leading-snug text-[var(--muted)]">
        Misspelled words get a red wavy underline. Right-click one to fix it, add it
        to your dictionary, or ignore it.
      </p>
      {settings.spellcheck && (
        <Segmented<SpellVariant>
          label="Dictionary"
          value={settings.spellVariant}
          options={[
            { value: "uk", label: "British" },
            { value: "us", label: "American" },
          ]}
          onChange={(spellVariant) => onChangeSettings({ spellVariant })}
        />
      )}
      <div className="my-1 border-t border-[var(--line)]" />
      <div className="px-2 py-1.5">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--faint)]">
          Personal dictionary{dictionary.length ? ` · ${dictionary.length}` : ""}
        </div>
        <form onSubmit={submit} className="flex gap-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a word…"
            className="min-w-0 flex-1 rounded-md border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-md bg-[var(--accent)] px-2 py-1 text-[12px] font-medium text-[var(--panel)] disabled:opacity-40"
          >
            Add
          </button>
        </form>
        {dictionary.length === 0 ? (
          <p className="mt-1.5 text-[11px] italic text-[var(--faint)]">No custom words yet.</p>
        ) : (
          <ul className="mt-1.5 max-h-40 overflow-y-auto">
            {dictionary.map((w) => (
              <li
                key={w}
                className="group flex items-center justify-between rounded px-1.5 py-1 text-[13px] text-[var(--ink)] hover:bg-[var(--line)]"
              >
                <span className="truncate">{w}</span>
                <button
                  type="button"
                  onClick={() => onRemoveWord(w)}
                  title={`Remove “${w}” from your dictionary`}
                  className="ml-2 shrink-0 rounded px-1 text-[var(--faint)] hover:text-[var(--crit-del)]"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const SAVE_BADGE: Record<SaveState, { label: string; color: string; title: string }> = {
  saved: { label: "Saved", color: "var(--muted)", title: "All changes saved to disk" },
  saving: { label: "Saving…", color: "var(--muted)", title: "Writing to disk…" },
  unsaved: { label: "Unsaved", color: "var(--crit-ins)", title: "Edits queued — saving shortly (⌘S to save now)" },
  offline: { label: "Offline · unsaved", color: "var(--crit-del)", title: "Disconnected — your edits are held and will be written on reconnect" },
  conflict: { label: "Conflict", color: "var(--crit-del)", title: "The file changed under your edit; your version is kept and will be saved" },
};

/** Explicit Saved / Saving / Unsaved / Offline / Conflict indicator. When saved,
 *  shows the wall-clock time of the last write (HH:MM:SS) for the paranoid. */
function SaveBadge({ state, lastSavedAt }: { state: SaveState; lastSavedAt: number | null }) {
  const s = SAVE_BADGE[state];
  const label =
    state === "saved" && lastSavedAt
      ? `Saved ${new Date(lastSavedAt).toLocaleTimeString([], { hour12: false })}`
      : s.label;
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] tabular-nums"
      style={{ color: s.color }}
      title={state === "saved" && lastSavedAt ? `Last written to disk at ${new Date(lastSavedAt).toLocaleTimeString()}` : s.title}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: s.color, opacity: state === "saved" ? 0.5 : 1 }}
      />
      {label}
    </span>
  );
}
