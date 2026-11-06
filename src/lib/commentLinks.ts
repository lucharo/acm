// Comment bodies are plain text, but reviewers cite sources in them (#68). Split a
// body into text and link segments so the rail can render `[text](url)` and bare
// http(s) URLs as real links. Only http(s) is ever linked: a `javascript:` or
// `data:` target in a comment written by an agent stays inert text.

export type CommentSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

// `[label](http…)` first, then a bare URL. The bare form stops at whitespace and
// at `<`/`>`/quotes, which never belong to a URL written in prose.
// A Markdown destination may hold balanced parens (`…/Foo_(bar)`), one level deep.
const LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|https?:\/\/[^\s<>"']+/g;

/** Trailing characters that end a sentence rather than the URL: `see https://x.com/a.`
 *  links `https://x.com/a`. A closing paren is kept only when the URL opened one,
 *  so `(https://en.wikipedia.org/wiki/Foo_(bar))` keeps its own `)`. */
function trimBareUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last && ".,;:!?'\"".includes(last)) {
      end -= 1;
      continue;
    }
    if (last === ")") {
      const slice = url.slice(0, end);
      const opens = slice.split("(").length - 1;
      const closes = slice.split(")").length - 1;
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    return url.slice(0, end);
  }
}

export function commentSegments(body: string): CommentSegment[] {
  const out: CommentSegment[] = [];
  let cursor = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev?.kind === "text") prev.text += text;
    else out.push({ kind: "text", text });
  };
  for (const match of body.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    pushText(body.slice(cursor, start));
    if (match[1] !== undefined) {
      out.push({ kind: "link", text: match[1], href: match[2] });
      cursor = start + match[0].length;
      continue;
    }
    const url = trimBareUrl(match[0]);
    out.push({ kind: "link", text: url, href: url });
    cursor = start + url.length;
  }
  pushText(body.slice(cursor));
  return out;
}
