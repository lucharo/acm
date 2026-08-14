import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import App from "./App";
import "katex/dist/katex.min.css";
import "./index.css";

// No StrictMode: the editor + WebSocket are imperative resources whose
// double-mount under StrictMode causes connect/destroy churn with no benefit
// for a single-user local app.

// Mount EXACTLY ONE React root, even if this entry is evaluated more than once
// against the same live #root (a re-injected/duplicated module script, certain dev
// HMR entry re-runs). A second createRoot() on a container that already has one
// mounts a SECOND App on top of the first — each with its own WebSocket and its
// own word-count + "Saved" badge — so the status bar shows several stacked counts
// and save timestamps that diverge as each instance saves independently. Stashing
// the root on the container makes any re-evaluation reuse it instead of stacking.
const container = document.getElementById("root")!;
type RootHost = HTMLElement & { _acmRoot?: Root };
const host = container as RootHost;
const root = host._acmRoot ?? (host._acmRoot = createRoot(container));
root.render(<App />);
