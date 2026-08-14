// ── useCodeMirror ─────────────────────────────────────────────────────────────
// A thin React hook around a RAW CodeMirror 6 EditorView. We deliberately do NOT
// use @uiw/react-codemirror: its controlled `value` prop fights external/agent
// edits. Here the view is UNCONTROLLED — the plain-text buffer is the source of
// truth, local edits flow OUT via onDocChanged, and remote/agent edits flow IN
// via applyRemote() as a minimal ranged transaction (prefix/suffix diff) that
// preserves scroll + selection and is tagged so it doesn't echo back out.
//
// The view is created ONCE (empty-deps effect) and never recreated. Fresh
// callbacks survive re-renders via a ref that the facet + listener read, plus a
// facet reconfigure so the click handlers always see the latest callbacks.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { EditorView, placeholder } from "@codemirror/view";
import { lineNumbers } from "@codemirror/view";
import { Annotation, Compartment, EditorState, StateEffect } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { history, invertedEffects, isolateHistory } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import { acmFormattingKeymap } from "./formatting";
import { listIndentKeymap } from "./listIndent";
import { CriticMarkup } from "./criticMarkupParser";
import { critCallbacksFacet, setCritHighlights } from "./criticMarkupView";
import type { CritCallbacks } from "./criticMarkupView";
import { documentPreviewExtension } from "./previewMode";
import { imageInsert } from "./imageInsert";
import type { ToastFn } from "./imageInsert";
import { footnotes } from "./footnotes";
import { bionicReading } from "./bionicView";
import { pageBreaks } from "./pageBreaks";
import { spellcheck } from "./spellcheck";
import { tableSlashKeymap } from "./tableInsert";
import { acmTheme, pageTheme } from "./theme";
import {
  composerAnchorExtension,
  setComposerAnchor as setComposerAnchorEffect,
} from "./composerAnchor";
import type { ComposerAnchorRange } from "./composerAnchor";
import type { DecisionEvent, DecisionQueueUpdate } from "../lib/decision";

export interface UseCodeMirrorOptions {
  initialDoc: string;
  callbacks: CritCallbacks;
  onDocChanged: (content: string, decisionUpdate: DecisionQueueUpdate) => void;
  onUpdate?: (u: ViewUpdate) => void;
  /** Open/toggle the keyboard-shortcuts cheat sheet (bound to ⌘/ in the editor). */
  onShowShortcuts?: () => void;
  /** Bottom-right toast — image drop/paste reports where the file was saved. */
  onToast?: ToastFn;
  lineNumbers?: boolean;
  page?: boolean;
  bionic?: boolean;
  pageBreaks?: boolean;
  spellcheck?: boolean;
  richPreview?: boolean;
}

type HighlightStateInput = { active: number | null; seen: number[]; busy: number[] };

export interface UseCodeMirrorResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewRef: React.MutableRefObject<EditorView | null>;
  applyRemote: (content: string) => void;
  /** Tell the editor which comment-anchor highlights are active / seen / busy (by `from`). */
  setHighlightState: (state: HighlightStateInput) => void;
  /** Keep the selected review anchor visible while its composer owns focus. */
  setComposerAnchor: (range: ComposerAnchorRange | null) => void;
}

/** Marks transactions that originate from a remote/agent edit, so the update
 *  listener can suppress the onDocChanged echo for them. */
const remoteAnnotation = Annotation.define<boolean>();
/** Review actions attach their canonical audit events to the same transaction as
 * the document edit, so one update feeds both through the versioned save path. */
export const decisionAnnotation = Annotation.define<DecisionEvent[]>();

const decisionHistoryEffect = StateEffect.define<{
  kind: "enqueue" | "cancel";
  events: DecisionEvent[];
}>();

/** Keep one review action isolated in CodeMirror history and carry its audit
 * identity through undo/redo without inventing a second decision event. */
export function decisionAnnotations(events: DecisionEvent[]) {
  return [decisionAnnotation.of(events), isolateHistory.of("full")];
}

/** CodeMirror history stores inverse effects. The original review transaction
 * queues its event; undo cancels it if it is still pending; redo requeues it. */
export const decisionHistoryExtension = invertedEffects.of((transaction) => {
  const inverse = [];
  const annotated = transaction.annotation(decisionAnnotation) ?? [];
  if (annotated.length > 0) {
    inverse.push(decisionHistoryEffect.of({ kind: "cancel", events: annotated }));
  }
  for (const effect of transaction.effects) {
    if (!effect.is(decisionHistoryEffect)) continue;
    inverse.push(
      decisionHistoryEffect.of({
        kind: effect.value.kind === "enqueue" ? "cancel" : "enqueue",
        events: effect.value.events,
      }),
    );
  }
  return inverse;
});

export function decisionQueueUpdateFromTransactions(
  transactions: readonly Transaction[],
): DecisionQueueUpdate {
  const update: DecisionQueueUpdate = { enqueue: [], cancel: [] };
  for (const transaction of transactions) {
    update.enqueue.push(...(transaction.annotation(decisionAnnotation) ?? []));
    for (const effect of transaction.effects) {
      if (!effect.is(decisionHistoryEffect)) continue;
      update[effect.value.kind].push(...effect.value.events);
    }
  }
  return update;
}

export function decisionEventsFromTransactions(
  transactions: readonly Transaction[],
): DecisionEvent[] {
  return decisionQueueUpdateFromTransactions(transactions).enqueue;
}

/** Length of the shared leading run of two strings. */
function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Length of the shared trailing run, not overlapping the prefix already taken. */
function commonSuffixLen(a: string, b: string, prefixLen: number): number {
  const max = Math.min(a.length, b.length) - prefixLen;
  let i = 0;
  while (
    i < max &&
    a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)
  ) {
    i++;
  }
  return i;
}

export function useCodeMirror(opts: UseCodeMirrorOptions): UseCodeMirrorResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const highlightStateRef = useRef<HighlightStateInput>({ active: null, seen: [], busy: [] });

  // Keep the latest options in a ref so the (once-created) view's listener and
  // callbacks always read current values without recreating the view.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Compartment lets us reconfigure the callbacks facet in place when callbacks
  // change identity, so widget clicks always invoke the freshest handlers.
  const callbacksCompartment = useRef(new Compartment());
  // Compartment for the optional line-number gutter (toggled from settings).
  const lineNumbersCompartment = useRef(new Compartment());
  // Compartment for the optional A4 "page" view (toggled from settings).
  const pageCompartment = useRef(new Compartment());
  // Compartment for the optional bionic-reading bolding (toggled from settings).
  const bionicCompartment = useRef(new Compartment());
  // Compartment for the optional A4 page-break markers (toggled from settings).
  const pageBreaksCompartment = useRef(new Compartment());
  // Compartment for the optional spell-check underline (toggled from settings).
  const spellcheckCompartment = useRef(new Compartment());
  // One global switch owns both Markdown and CriticMarkup presentation layers.
  const previewCompartment = useRef(new Compartment());

  // Create the view exactly once.
  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const updateListener = EditorView.updateListener.of((update) => {
      optsRef.current.onUpdate?.(update);
      if (!update.docChanged) return;
      const isRemote = update.transactions.some((tr) =>
        tr.annotation(remoteAnnotation),
      );
      if (!isRemote) {
        const decisionUpdate = decisionQueueUpdateFromTransactions(update.transactions);
        optsRef.current.onDocChanged(update.state.doc.toString(), decisionUpdate);
      }
    });

    const state = EditorState.create({
      doc: optsRef.current.initialDoc,
      extensions: [
        history(),
        decisionHistoryExtension,
        // Formatting keymap goes FIRST so ⌘I overrides the default keymap's
        // selectParentSyntax (and ⌘B, which the default keymap leaves unbound).
        // ⌘/ opens the cheat sheet — bound here (ahead of defaults) so it overrides
        // CodeMirror's toggle-comment, which is meaningless in prose.
        keymap.of([
          ...tableSlashKeymap,
          ...listIndentKeymap,
          ...acmFormattingKeymap,
          {
            key: "Mod-/",
            preventDefault: true,
            run: () => {
              optsRef.current.onShowShortcuts?.();
              return true;
            },
          },
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": "Markdown document editor",
        }),
        placeholder("Start writing…"),
        // NB: we deliberately do NOT use drawSelection(). It paints the selection on a
        // layer BEHIND the text, which the doc's pervasive yellow {==..==} highlight
        // backgrounds then hide — so selecting highlighted text looked like nothing
        // happened ("can't highlight at all"). Native browser selection composites
        // ON TOP of text + its background, so it's visible everywhere (styled via the
        // ::selection rule in theme.ts). We don't need multi-range/rectangular select.
        markdown({ base: markdownLanguage, extensions: [CriticMarkup] }),
        previewCompartment.current.of(
          documentPreviewExtension(optsRef.current.richPreview ?? true),
        ),
        // Image drop/paste — reads the toast through optsRef so it always
        // reaches the app shell's freshest handler (same pattern as onUpdate).
        imageInsert((msg, kind) => optsRef.current.onToast?.(msg, kind)),
        footnotes,
        composerAnchorExtension,
        acmTheme,
        callbacksCompartment.current.of(
          critCallbacksFacet.of(optsRef.current.callbacks),
        ),
        lineNumbersCompartment.current.of(
          optsRef.current.lineNumbers ? lineNumbers() : [],
        ),
        pageCompartment.current.of(optsRef.current.page ? pageTheme : []),
        bionicCompartment.current.of(optsRef.current.bionic ? bionicReading : []),
        pageBreaksCompartment.current.of(optsRef.current.pageBreaks ? pageBreaks : []),
        spellcheckCompartment.current.of(optsRef.current.spellcheck ? spellcheck : []),
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent });
    viewRef.current = view;
    // Dev-only escape hatch: lets headless debugging (agent-browser eval) reach the
    // live view to introspect parse state / decorations. Stripped in prod builds.
    if (import.meta.env?.DEV) (window as unknown as Record<string, unknown>).__acmView = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure the callbacks facet whenever the callbacks object identity
  // changes — keeps click handlers fresh without recreating the view.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: callbacksCompartment.current.reconfigure(
        critCallbacksFacet.of(opts.callbacks),
      ),
    });
  }, [opts.callbacks]);

  // Toggle the line-number gutter in place when the setting changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: lineNumbersCompartment.current.reconfigure(
        opts.lineNumbers ? lineNumbers() : [],
      ),
    });
  }, [opts.lineNumbers]);

  // Toggle the A4 page view in place when the setting changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: pageCompartment.current.reconfigure(opts.page ? pageTheme : []),
    });
  }, [opts.page]);

  // Toggle bionic-reading bolding in place when the setting changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: bionicCompartment.current.reconfigure(opts.bionic ? bionicReading : []),
    });
  }, [opts.bionic]);

  // Toggle the A4 page-break markers in place when the setting changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: pageBreaksCompartment.current.reconfigure(opts.pageBreaks ? pageBreaks : []),
    });
  }, [opts.pageBreaks]);

  // Toggle the spell-check underline in place when the setting changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: spellcheckCompartment.current.reconfigure(
        opts.spellcheck ? spellcheck : [],
      ),
    });
  }, [opts.spellcheck]);

  // Rich/raw is global and presentation-only: reconfigure the block/inline
  // layers without recreating the editor or changing a byte of the document.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const enabled = opts.richPreview ?? true;
    view.dispatch({
      effects: previewCompartment.current.reconfigure(
        documentPreviewExtension(enabled),
      ),
    });
    if (enabled) {
      view.dispatch({ effects: setCritHighlights.of(highlightStateRef.current) });
    }
  }, [opts.richPreview]);

  // Apply a full remote snapshot as a minimal ranged edit (prefix/suffix diff).
  // Stable identity (reads only the stable viewRef) so consumers' effects that
  // depend on the returned object don't tear down every render.
  const applyRemote = useCallback((content: string) => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (content === current) return;

    const prefix = commonPrefixLen(current, content);
    const suffix = commonSuffixLen(current, content, prefix);
    const from = prefix;
    const curEnd = current.length - suffix;
    const insert = content.slice(prefix, content.length - suffix);

    view.dispatch({
      changes: { from, to: curEnd, insert },
      annotations: remoteAnnotation.of(true),
      // No scrollIntoView — preserve the reader's position. Selection maps
      // through the change automatically.
    });
  }, []);

  const setHighlightState = useCallback(
    (state: HighlightStateInput) => {
      highlightStateRef.current = state;
      viewRef.current?.dispatch({ effects: setCritHighlights.of(state) });
    },
    [],
  );

  const setComposerAnchor = useCallback((range: ComposerAnchorRange | null) => {
    viewRef.current?.dispatch({ effects: setComposerAnchorEffect.of(range) });
  }, []);

  return useMemo(
    () => ({ containerRef, viewRef, applyRemote, setHighlightState, setComposerAnchor }),
    [applyRemote, setHighlightState, setComposerAnchor],
  );
}
