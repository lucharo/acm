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
import { IMAGE_EXT_BY_MIME } from "../lib/imageTypes";
import type { ToastKind } from "../lib/types";

/** Bottom-right toast, provided by the app shell. */
export type ToastFn = (message: string, kind?: ToastKind) => void;

const isImage = (f: File) => /^image\//.test(f.type);

/** A dragged image ELEMENT (from a webpage, another app) carries no File —
 *  just a text/uri-list. Left unhandled, the browser's default is to NAVIGATE
 *  to that URI (a data: tab full of base64). Decode a data:image URI into a
 *  File so it takes the normal asset path, or null for anything else. */
function fileFromDataUri(uri: string): File | null {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/is.exec(uri.trim());
  if (!m) return null;
  const ext = IMAGE_EXT_BY_MIME[m[1].toLowerCase()];
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

/** POST the bytes; the server names the file (content-addressed) and returns
 *  the doc-relative path + the slugged stem for the alt text — the client
 *  never re-parses the naming scheme. */
async function upload(file: File): Promise<{ path: string; stem: string }> {
  const res = await fetch(`/api/asset?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    body: file,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as { path: string; stem: string };
}

/** Upload the image files among `files` and insert their references at `pos`.
 *  Always consumes the gesture: non-images get a rejection toast, a failed
 *  upload gets an error toast and no insert. Callers guarantee `files` is
 *  non-empty. */
function insertImages(view: EditorView, files: File[], pos: number, toast: ToastFn): boolean {
  const images = files.filter(isImage);
  if (images.length === 0) {
    toast("Only images can be dropped into the doc", "error");
    return true;
  }
  void (async () => {
    try {
      const saved = [];
      for (const f of images) saved.push(await upload(f));
      const at = Math.min(pos, view.state.doc.length);
      const text = saved.map((s) => `![${s.stem}](${s.path})`).join("\n");
      view.dispatch({
        changes: { from: at, insert: text },
        selection: { anchor: at + text.length },
        scrollIntoView: true,
      });
      toast(saved.length === 1 ? `Saved ${saved[0].path}` : `Saved ${saved.length} images to assets/`);
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
    // never fires drop. The discriminator is text/uri-list PRESENCE, not
    // text/plain absence: a dragged <img>/link carries BOTH (both set to the
    // URL), while an in-editor text-selection drag carries text/plain only —
    // so uri-list is what separates element drags from CodeMirror's own.
    dragover(e) {
      const t = e.dataTransfer?.types;
      if (t && (t.includes("Files") || t.includes("text/uri-list"))) {
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
        return insertImages(view, files, pos, toast);
      }
      // No File: a dragged element (image or link). Its uri-list is either a
      // data: URI (decode → normal asset path) or a remote URL (insert a
      // remote ref). Never let it fall through — the browser default
      // NAVIGATES to the URI. Text-selection drags have no uri-list.
      const uri = dt?.getData("text/uri-list").split(/\r?\n/).find((l) => l && !l.startsWith("#")) ?? "";
      if (!uri) return false; // text drag — CodeMirror handles
      if (uri.startsWith("data:")) {
        e.preventDefault();
        const f = fileFromDataUri(uri);
        if (!f) {
          toast("Couldn't read the dragged image", "error");
          return true;
        }
        return insertImages(view, [f], pos, toast);
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
      // Paste is the one gesture with no filename to derive an extension from:
      // rename supported images to the decided `pasted.<ext>` stem here, and
      // reject unsupported MIME types (tiff/heic…) rather than mislabel them
      // (roborev #3439). Drops keep their name; the server stays the authority.
      const images = Array.from(e.clipboardData?.files ?? []).filter(isImage);
      if (images.length === 0) return false; // normal text paste
      e.preventDefault();
      const supported = images.filter((f) => IMAGE_EXT_BY_MIME[f.type]);
      const unsupported = images.filter((f) => !IMAGE_EXT_BY_MIME[f.type]);
      if (unsupported.length)
        toast(`Unsupported image type: ${unsupported.map((f) => f.type).join(", ")}`, "error");
      if (supported.length === 0) return true;
      const renamed = supported.map(
        (f) => new File([f], `pasted.${IMAGE_EXT_BY_MIME[f.type]}`, { type: f.type }),
      );
      return insertImages(view, renamed, view.state.selection.main.head, toast);
    },
  });
}
