// ── App header: document controls, status, review controls, and settings ─────
// Purely presentational — every action and all state arrive as props from the
// Workspace; the only local state is whether the settings menu is open.

import { useState } from "react";
import type { FormEvent } from "react";
import { CodeXml, Eye, ListTree, MessageSquare, PanelRight, Settings } from "lucide-react";
import { MOD } from "../lib/platform";
import type { SaveState } from "../client/useDocSync";
import { FONT_STACKS, FONT_LABELS } from "../lib/viewSettings";
import type { Font, Theme, SpellVariant, PrintStyle, ViewSettings } from "../lib/viewSettings";
import { documentFileName } from "../lib/documentTitle";

export interface HeaderProps {
  /** Absolute path of the served document, shown as its file name (#33). */
  documentPath?: string;
  connected: boolean;
  saveState: SaveState;
  lastSavedAt: number | null;
  wordCount: number;
  onWrap: () => void;
  tocOpen: boolean;
  onToggleToc: () => void;
  commentRailVisible: boolean;
  commentsSurface: "rail" | "sheet";
  onToggleCommentRail: () => void;
  settings: ViewSettings;
  onChangeSettings: (patch: Partial<ViewSettings>) => void;
  settingsSaveError: boolean;
  onRetrySettings: () => void;
  /** Settings menu open-state is lifted to the Workspace so ⌘, can toggle it. */
  settingsOpen: boolean;
  onSetSettingsOpen: (open: boolean) => void;
  /** Open the keyboard-shortcuts cheat sheet. */
  onShowShortcuts: () => void;
  /** Print the accepted document using the persisted PDF presentation. */
  onPrint: () => void;
  /** The user's personal spelling dictionary + add/remove (Spelling tab). */
  dictionary: string[];
  onAddWord: (word: string) => void;
  onRemoveWord: (word: string) => void;
  /** Count of flagged words in the document + opener for the review modal. */
  flaggedCount: number;
  onOpenReview: () => void;
}

export const headerIconButtonClass =
  "flex h-10 w-10 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)] lg:h-7 lg:w-7";

export function previewModePresentation(richPreview: boolean) {
  return richPreview
    ? ({ label: "Show raw Markdown source", icon: "code" } as const)
    : ({ label: "Show rich preview", icon: "eye" } as const);
}

export function commentsTogglePresentation(
  visible: boolean,
  surface: "rail" | "sheet",
) {
  if (surface === "sheet") {
    return {
      label: visible ? "Hide comments" : "Show comments",
      icon: "message-square" as const,
    };
  }
  return {
    label: visible ? "Hide comments edge" : "Show comments edge",
    icon: "panel-right" as const,
  };
}

export default function Header(props: HeaderProps) {
  const {
    documentPath,
    connected,
    saveState,
    lastSavedAt,
    wordCount,
    onWrap,
    tocOpen,
    onToggleToc,
    commentRailVisible,
    commentsSurface,
    onToggleCommentRail,
    settings,
    onChangeSettings,
    settingsSaveError,
    onRetrySettings,
    settingsOpen,
    onSetSettingsOpen,
    onShowShortcuts,
    onPrint,
    dictionary,
    onAddWord,
    onRemoveWord,
    flaggedCount,
    onOpenReview,
  } = props;

  // settingsOpen is lifted to the Workspace (prop) so ⌘, can toggle it; only the
  // Display|Review|Spelling tab choice is local.
  const [settingsTab, setSettingsTab] = useState<"display" | "review" | "spelling">("display");

  return (
    <header className="relative flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--line)] bg-[var(--panel)] px-3 py-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleToc}
          className={`${headerIconButtonClass} ${tocOpen ? "bg-[var(--line)] text-[var(--ink)]" : ""}`}
          title={tocOpen ? "Hide table of contents" : "Table of contents"}
          aria-label={tocOpen ? "Hide table of contents" : "Table of contents"}
          aria-pressed={tocOpen}
        >
          <ListTree size={17} strokeWidth={1.7} aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => onChangeSettings({ richPreview: !settings.richPreview })}
          className={`${headerIconButtonClass} ${!settings.richPreview ? "bg-[var(--line)] text-[var(--ink)]" : ""}`}
          title={previewModePresentation(settings.richPreview).label}
          aria-label={previewModePresentation(settings.richPreview).label}
          aria-pressed={!settings.richPreview}
        >
          {previewModePresentation(settings.richPreview).icon === "code" ? (
            <CodeXml size={17} strokeWidth={1.7} aria-hidden="true" />
          ) : (
            <Eye size={17} strokeWidth={1.7} aria-hidden="true" />
          )}
        </button>
      </div>

      <span className="hidden h-5 w-px bg-[var(--line-strong)] min-[360px]:block" aria-hidden="true" />
      <span className="hidden text-[13px] font-semibold tracking-tight min-[360px]:inline">
        ACM <span className="hidden text-[var(--faint)] sm:inline">· Agent CriticMarkup</span>
        {documentPath && (
          <span
            className="ml-1 inline-block max-w-[40vw] truncate align-bottom text-[var(--muted)]"
            title={documentPath}
          >
            · {documentFileName(documentPath)}
          </span>
        )}
      </span>

      <div className="ml-auto flex flex-wrap items-center justify-end gap-2 gap-y-1">
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

        <button
          type="button"
          onClick={onToggleCommentRail}
          className={`${headerIconButtonClass} ${commentRailVisible ? "bg-[var(--line)] text-[var(--ink)]" : ""}`}
          title={commentsTogglePresentation(commentRailVisible, commentsSurface).label}
          aria-label={commentsTogglePresentation(commentRailVisible, commentsSurface).label}
          aria-pressed={commentRailVisible}
        >
          {commentsTogglePresentation(commentRailVisible, commentsSurface).icon === "message-square" ? (
            <MessageSquare size={17} strokeWidth={1.7} aria-hidden="true" />
          ) : (
            <PanelRight size={17} strokeWidth={1.7} aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          onClick={() => onSetSettingsOpen(!settingsOpen)}
          className={`${headerIconButtonClass} ${settingsOpen ? "bg-[var(--line)] text-[var(--ink)]" : ""}`}
          title={`Settings (${MOD},)`}
          aria-label="Settings"
          aria-haspopup="menu"
          aria-expanded={settingsOpen}
        >
          <Settings size={17} strokeWidth={1.7} aria-hidden="true" />
        </button>

        {settingsOpen ? (
          <>
            <div className="fixed inset-0 z-20" onClick={() => onSetSettingsOpen(false)} />
            <div className="absolute right-3 top-11 z-30 max-h-[calc(100vh-4rem)] w-60 overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1.5 shadow-lg">
              {/* Purpose-based tabs keep review behaviour distinct from visual
                  preferences and give the dictionary its own home. */}
              <div className="mb-1.5 flex gap-1 rounded-md bg-[var(--line)] p-0.5">
                {(["display", "review", "spelling"] as const).map((t) => (
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
              <p className="mb-1.5 px-2 text-[11px] leading-snug text-[var(--muted)]">
                Settings are global and apply to every ACM document.
              </p>
              {settingsSaveError ? (
                <button
                  type="button"
                  onClick={onRetrySettings}
                  className="mb-1.5 w-full rounded-md border border-[var(--crit-del)] px-2 py-1.5 text-left text-[11px] text-[var(--crit-del)]"
                >
                  Settings not saved. Retry
                </button>
              ) : null}
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
                label="Rich preview"
                checked={settings.richPreview}
                onToggle={() => onChangeSettings({ richPreview: !settings.richPreview })}
              />
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
                label="Reading progress bar"
                checked={settings.progressBar}
                onToggle={() => onChangeSettings({ progressBar: !settings.progressBar })}
              />
              <div className="my-1 border-t border-[var(--line)]" />
              <Segmented<PrintStyle>
                label="PDF style"
                value={settings.printStyle}
                options={[
                  { value: "simple", label: "Simple" },
                  { value: "tufte", label: "Tufte" },
                ]}
                onChange={(printStyle) => onChangeSettings({ printStyle })}
              />
              <p className="px-2 pb-1.5 text-[11px] leading-snug text-[var(--muted)]">
                Exports accepted CriticMarkup. Unapplied SUGGEST cards keep the current wording.
              </p>
              {settings.printStyle === "tufte" ? (
                <>
                  <SettingRow
                    label="Reference rib on alternating pages"
                    checked={settings.printAlternateSides}
                    onToggle={() => onChangeSettings({ printAlternateSides: !settings.printAlternateSides })}
                  />
                  <p className="px-2 pb-1.5 text-[11px] leading-snug text-[var(--muted)]">
                    Odd pages use the right outer margin; even pages use the left. Turn off to keep references right.
                  </p>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  onSetSettingsOpen(false);
                  onPrint();
                }}
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--ink)] hover:bg-[var(--line)]"
              >
                Print / save as PDF <span className="text-[11px] text-[var(--faint)]">{MOD}P</span>
              </button>
              <SettingRow
                label="Show seen comments"
                checked={settings.showSeen}
                onToggle={() => onChangeSettings({ showSeen: !settings.showSeen })}
              />
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
                  Run <code className="rounded bg-[var(--line)] px-1 text-[var(--ink)]">bun run setup</code> from
                  the ACM repository to install or refresh it through the standard skills manager.
                </p>
              </div>
              </>
              ) : settingsTab === "review" ? (
                <ReviewTab settings={settings} onChangeSettings={onChangeSettings} />
              ) : (
                <SpellingTab
                  settings={settings}
                  onChangeSettings={onChangeSettings}
                  dictionary={dictionary}
                  onAddWord={onAddWord}
                  onRemoveWord={onRemoveWord}
                  flaggedCount={flaggedCount}
                  onOpenReview={onOpenReview}
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

/** Review behaviour stays conservative by default. The explicit combined action
 * is always available beside Apply; this setting only changes the plain Apply
 * shortcut for people who consistently want the thread closed too. */
function ReviewTab({
  settings,
  onChangeSettings,
}: {
  settings: ViewSettings;
  onChangeSettings: (patch: Partial<ViewSettings>) => void;
}) {
  return (
    <div>
      <Segmented
        label="Comments edge"
        value={settings.commentRail}
        options={[
          { value: "auto", label: "Auto" },
          { value: "show", label: "Show" },
          { value: "hide", label: "Hide" },
        ]}
        onChange={(commentRail) => onChangeSettings({ commentRail })}
      />
      <p className="px-2 pb-2 text-[11px] leading-snug text-[var(--muted)]">
        Automatic keeps a clean document centred, then opens the edge when review cards appear.
      </p>
      <div className="my-1 border-t border-[var(--line)]" />
      <SettingRow
        label="Apply also resolves"
        checked={settings.applyAndResolve}
        onToggle={() => onChangeSettings({ applyAndResolve: !settings.applyAndResolve })}
      />
      <p className="px-2 pb-2 text-[11px] leading-snug text-[var(--muted)]">
        Off by default. When enabled, Apply updates the wording and closes its complete
        discussion in one undoable action.
      </p>
    </div>
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
  flaggedCount,
  onOpenReview,
}: {
  settings: ViewSettings;
  onChangeSettings: (patch: Partial<ViewSettings>) => void;
  dictionary: string[];
  onAddWord: (word: string) => void;
  onRemoveWord: (word: string) => void;
  flaggedCount: number;
  onOpenReview: () => void;
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
      {settings.spellcheck && (
        <button
          type="button"
          onClick={onOpenReview}
          disabled={flaggedCount === 0}
          title="Review every flagged word in one place"
          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--ink)] hover:bg-[var(--line)] disabled:opacity-50 disabled:hover:bg-transparent"
        >
          Review flagged words
          <span className="text-[11px] text-[var(--faint)]">{flaggedCount || "none"}</span>
        </button>
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
  "audit-error": {
    label: "History not saved",
    color: "var(--crit-del)",
    title: "The document was saved, but its decision history was not. Press ⌘S to retry after fixing storage.",
  },
  "audit-recovery": {
    label: "History needs review",
    color: "var(--crit-del)",
    title: "Ambiguous unsent decision history was preserved in this browser rather than replayed without proof that its document edit landed.",
  },
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
