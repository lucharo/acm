// ── Image insert: drag-drop + paste (issue #3) ───────────────────────────────
// Dropping or pasting an image uploads the bytes to POST /api/asset (the server
// writes <docDir>/assets/<stem>-<hash8>.<ext> and returns the doc-relative
// path), then inserts `![stem](assets/…)` at the drop point / cursor as a plain
// human edit — no {++…++} wrapper, consistent with typing being direct while
// only agents suggest. Non-image files are rejected with a toast and the
// document is untouched. Rendering the inserted reference is markdownPreview's
// ImageWidget; feedback (where the file landed / errors) is the toast.
//
// Upload-first, insert-on-success: a failed upload never leaves a dangling
// `![](…)` pointing at nothing. The insert position is captured at gesture time
// and clamped to the doc length afterwards — the doc may shrink while the
// upload is in flight.

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** Bottom-right toast, provided by the app shell. */
export type ToastFn = (message: string, kind?: "info" | "error") => void;

const isImage = (f: File) => /^image\//.test(f.type);

// The formats the server accepts (magic-byte-verified there). No fallback: an
// unsupported paste type (image/tiff, image/heic…) is rejected with a toast,
// not silently uploaded under a .png name it can't honour (roborev #3439).
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

/** Alt text = the asset's stem minus the content-hash suffix. */
function altFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.[a-z0-9]+$/i, "").replace(/-[0-9a-f]{8}$/, "");
}

async function upload(file: File, origin: "drop" | "paste"): Promise<string> {
  // Pasted images get the decided generic stem; drops keep their filename. The
  // server re-verifies the bytes against the extension either way.
  const name =
    origin === "paste" ? `pasted.${EXT_BY_MIME[file.type]}` : file.name || `image.${EXT_BY_MIME[file.type] ?? "png"}`;
  const res = await fetch(`/api/asset?name=${encodeURIComponent(name)}`, {
    method: "POST",
    body: file,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return ((await res.json()) as { path: string }).path;
}

function insertImages(
  view: EditorView,
  files: File[],
  pos: number,
  origin: "drop" | "paste",
  toast: ToastFn,
): boolean {
  let images = files.filter(isImage);
  if (images.length === 0) {
    if (files.length) toast("Only images can be dropped into the doc", "error");
    return files.length > 0; // consumed the gesture (rejection) or not ours at all
  }
  // A paste has no filename to derive the extension from, so an unsupported
  // MIME type is rejected here; drops keep their name and the server decides.
  if (origin === "paste") {
    const unsupported = images.filter((f) => !EXT_BY_MIME[f.type]);
    if (unsupported.length) {
      toast(`Unsupported image type: ${unsupported.map((f) => f.type).join(", ")}`, "error");
      images = images.filter((f) => EXT_BY_MIME[f.type]);
      if (images.length === 0) return true;
    }
  }
  void (async () => {
    try {
      const paths = [];
      for (const f of images) paths.push(await upload(f, origin));
      const at = Math.min(pos, view.state.doc.length);
      const text = paths.map((p) => `![${altFromPath(p)}](${p})`).join("\n");
      view.dispatch({
        changes: { from: at, insert: text },
        selection: { anchor: at + text.length },
        scrollIntoView: true,
      });
      toast(paths.length === 1 ? `Saved ${paths[0]}` : `Saved ${paths.length} images to assets/`);
      if (images.length < files.length) toast("Skipped non-image files", "error");
    } catch (err) {
      toast(`Image save failed — ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  })();
  return true;
}

/** The drop/paste image-insert extension. `toast` is read per-event so the app
 *  shell can hand in a stable closure over its freshest state. */
export function imageInsert(toast: ToastFn): Extension {
  return EditorView.domEventHandlers({
    // Files need an explicit dragover preventDefault or the browser never fires
    // drop; text drags (no Files) stay with CodeMirror's native handling.
    dragover(e) {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        return true;
      }
      return false;
    },
    drop(e, view) {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return false; // text drag — CodeMirror handles
      e.preventDefault(); // stop CM's own file-drop (it would paste bytes as text)
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
      return insertImages(view, files, pos, "drop", toast);
    },
    paste(e, view) {
      const files = Array.from(e.clipboardData?.files ?? []).filter(isImage);
      if (files.length === 0) return false; // normal text paste
      e.preventDefault();
      return insertImages(view, files, view.state.selection.main.head, "paste", toast);
    },
  });
}
