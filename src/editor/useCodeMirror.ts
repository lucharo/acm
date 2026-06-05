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
import { EditorView } from "@codemirror/view";
import { lineNumbers } from "@codemirror/view";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import { CriticMarkup } from "./criticMarkupParser";
import { criticMarkupExtension, critCallbacksFacet, setCritHighlights, setInlineSuggestions } from "./criticMarkupView";
import type { CritCallbacks } from "./criticMarkupView";
import type { InlineSuggestion } from "../lib/criticmarkup";
import { markdownPreview } from "./markdownPreview";
import { bionicReading } from "./bionicView";
import { acmTheme, pageTheme } from "./theme";

export interface UseCodeMirrorOptions {
  initialDoc: string;
  callbacks: CritCallbacks;
  onDocChanged: (content: string) => void;
  onUpdate?: (u: ViewUpdate) => void;
  lineNumbers?: boolean;
  page?: boolean;
  bionic?: boolean;
}

export interface UseCodeMirrorResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewRef: React.MutableRefObject<EditorView | null>;
  applyRemote: (content: string) => void;
  /** Tell the editor which comment-anchor highlights are active / seen / busy (by `from`). */
  setHighlightState: (state: { active: number | null; seen: number[]; busy: number[] }) => void;
  /** Push the anchored SUGGEST: pairs for the inline accept/reject layer. */
  pushInlineSuggestions: (suggestions: InlineSuggestion[]) => void;
}

/** Marks transactions that originate from a remote/agent edit, so the update
 *  listener can suppress the onDocChanged echo for them. */
const remoteAnnotation = Annotation.define<boolean>();

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
        optsRef.current.onDocChanged(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: optsRef.current.initialDoc,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        // NB: we deliberately do NOT use drawSelection(). It paints the selection on a
        // layer BEHIND the text, which the doc's pervasive yellow {==..==} highlight
        // backgrounds then hide — so selecting highlighted text looked like nothing
        // happened ("can't highlight at all"). Native browser selection composites
        // ON TOP of text + its background, so it's visible everywhere (styled via the
        // ::selection rule in theme.ts). We don't need multi-range/rectangular select.
        markdown({ base: markdownLanguage, extensions: [CriticMarkup] }),
        markdownPreview,
        criticMarkupExtension(),
        acmTheme,
        callbacksCompartment.current.of(
          critCallbacksFacet.of(optsRef.current.callbacks),
        ),
        lineNumbersCompartment.current.of(
          optsRef.current.lineNumbers ? lineNumbers() : [],
        ),
        pageCompartment.current.of(optsRef.current.page ? pageTheme : []),
        bionicCompartment.current.of(optsRef.current.bionic ? bionicReading : []),
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent });
    viewRef.current = view;

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
    (state: { active: number | null; seen: number[]; busy: number[] }) => {
      viewRef.current?.dispatch({ effects: setCritHighlights.of(state) });
    },
    [],
  );

  const pushInlineSuggestions = useCallback((suggestions: InlineSuggestion[]) => {
    viewRef.current?.dispatch({ effects: setInlineSuggestions.of(suggestions) });
  }, []);

  return useMemo(
    () => ({ containerRef, viewRef, applyRemote, setHighlightState, pushInlineSuggestions }),
    [applyRemote, setHighlightState, pushInlineSuggestions],
  );
}
