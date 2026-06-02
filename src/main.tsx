import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// No StrictMode: the editor + WebSocket are imperative resources whose
// double-mount under StrictMode causes connect/destroy churn with no benefit
// for a single-user local app.
createRoot(document.getElementById("root")!).render(<App />);
