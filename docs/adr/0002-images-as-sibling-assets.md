# Images are sibling asset files, not data URIs

**Status:** accepted

Dropping or pasting an image saves the bytes to `assets/<stem>-<hash8>.<ext>`
beside the document and inserts `![stem](assets/…)` at that point; the server
gains a traversal-guarded route that serves files under the doc's directory.
The alternative — base64 data URIs inline in the `.md` — would keep the doc
self-contained but was rejected: a single screenshot becomes ~1.4 MB of base64
mid-prose, which wrecks the document's readability (the whole point of ACM is a
human-readable co-edited source), bloats every git-history commit, and pushes
megabyte strings through the `merge3`/`commitWrite` path on every save.

## Consequences

- The `.md` alone is no longer the complete document — moving it means moving
  `assets/` too. Accepted: prose with figures is a folder, like it is for any
  static-site source.
- The `<stem>-<hash8>` name is content-addressed on purpose: re-dropping the
  same image reuses the same file (no duplicate litter), and names never
  collide without needing `-1`/`-2` suffix bookkeeping.
- Orphaned assets (reference deleted from the prose, file left behind) are NOT
  garbage-collected. Deleting user files automatically is riskier than the
  clutter; cleanup is manual.
- The serve route deliberately covers *any* path under the doc's directory (not
  just `assets/`) so hand-written references like `![](figures/plot.png)` in
  pre-existing docs render too. Paths resolving above the doc directory 404.
- Uploads are magic-byte verified (bytes must sniff as the claimed extension),
  and **SVG is not an accepted upload type**: it's a text format with nothing to
  sniff, and a script-bearing SVG served from the app's origin is a stored-XSS
  surface. Hand-written `.svg` references on disk still render (served with
  `Content-Security-Policy: sandbox`).
