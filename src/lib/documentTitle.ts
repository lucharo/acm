// The browser tab names the document being edited (#33): with several ACM tabs
// open, or a server started on the wrong file, the tab is where you notice.

/** `notes.md` for `/any/dir/notes.md`. */
export function documentFileName(documentPath: string): string {
  return documentPath.split(/[\\/]/).pop() || documentPath;
}

/** `notes.md — ACM` for `/any/dir/notes.md`. */
export function documentTabTitle(documentPath: string): string {
  return `${documentFileName(documentPath)} — ACM`;
}
