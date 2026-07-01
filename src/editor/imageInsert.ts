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

/** A dragged image ELEMENT (from a webpage, another app) carries no File —
 *  just a text/uri-list. Left unhandled, the browser's default is to NAVIGATE
 *  to that URI (a data: tab full of base64). Decode a data:image URI into a
 *  File so it takes the normal asset path, or null for anything else. */
function fileFromDataUri(uri: string): File | null {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/is.exec(uri.trim());
  if (!m) return null;
  const ext = EXT_BY_MIME[m[1].toLowerCase()];
  if (!ext) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], `dropped.${ext}`, { type: m[1].toLowerCase() });
  } catch {
    return null;
  }
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
    // Files/uri-lists need an explicit dragover preventDefault or the browser
    // never fires drop; in-editor text drags (text/plain, no Files) stay with
    // CodeMirror's native handling.
    dragover(e) {
      const t = e.dataTransfer?.types;
      if (t && (t.includes("Files") || (t.includes("text/uri-list") && !t.includes("text/plain")))) {
        e.preventDefault();
        return true;
      }
      return false;
    },
    drop(e, view) {
      const dt = e.dataTransfer;
      const files = Array.from(dt?.files ?? []);
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
      if (files.length) {
        e.preventDefault(); // stop CM's own file-drop (it would paste bytes as text)
        return insertImages(view, files, pos, "drop", toast);
      }
      // No File: a dragged image element. Its uri-list is either a data: URI
      // (decode → normal asset path) or a remote URL (insert a remote ref).
      // Never let it fall through — the browser default navigates away.
      const uri = dt?.getData("text/uri-list").split(/\r?\n/).find((l) => l && !l.startsWith("#")) ?? "";
      if (!uri || (dt?.types.includes("text/plain") && !uri.startsWith("data:"))) return false; // text drag
      if (uri.startsWith("data:")) {
        e.preventDefault();
        const f = fileFromDataUri(uri);
        if (!f) {
          toast("Couldn't read the dragged image", "error");
          return true;
        }
        return insertImages(view, [f], pos, "drop", toast);
      }
      if (/^https?:/i.test(uri)) {
        e.preventDefault(); // remote image: reference it, don't copy it
        const text = `![image](${uri})`;
        view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
        return true;
      }
      return false;
    },
    paste(e, view) {
      const files = Array.from(e.clipboardData?.files ?? []).filter(isImage);
      if (files.length === 0) return false; // normal text paste
      e.preventDefault();
      return insertImages(view, files, view.state.selection.main.head, "paste", toast);
    },
  });
}
