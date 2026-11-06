export interface EditInvocation {
  kind: "edit";
  file?: string;
  port?: number;
  /** Folder relative images may reach (default: the doc's git repo, else its folder). */
  assetRoot?: string;
  /** Remote host names to accept besides loopback (repeatable --allow-host). */
  allowHosts?: string[];
  open: boolean;
}

export type Invocation =
  | { kind: "overview" }
  | { kind: "help" }
  | { kind: "agent"; verb: string; args: string[] }
  | { kind: "legacy-skill" }
  | EditInvocation
  | { kind: "error"; message: string };

export const OVERVIEW_TEXT = `ACM — Agent CriticMarkup

A local editor where people and agents review one Markdown document together.
The Markdown file stays the source of truth.

Start editing:
  acm edit                 Open New / Open / Recent Documents
  acm edit essay.md        Open or create an explicitly named document

Review from the shell:
  acm threads              List open discussions and suggestions
  acm --help               Show every command and option`;

export const HELP_TEXT = `acm — Agent CriticMarkup editor

Usage:
  acm                         Explain ACM and list the main commands
  acm edit                    Open the New / Open / Recent Documents launcher
  acm edit <file.md>          Open the file, creating it if missing

Agent verbs (doc resolution: --doc <file.md> > $ACM_DOC > the doc open in the
running ACM editor; snapshot before every write):
  acm threads [--json]              List threads: anchor, authors, count, [SUGGEST]
  acm comment "<span>" "<text>"     New comment anchored on the unique prose <span>
  acm reply "<phrase>" "<text>"     Reply to the thread matching <phrase> (= comment -r)
  acm suggest "<span>" "<new>"      Anchor a SUGGEST: on the unique prose <span>
  acm accept "<phrase>"             Accept the suggestion matching <phrase>
  acm reject "<phrase>"             Reject it (keep the original span)
  acm resolve "<phrase>"            Strip the thread matching <phrase>
  acm reply --batch <edits.json>    Batch reply-append (idempotent); [{id,match,insert}]
  acm wrap [width]                  Hard-wrap prose (default 88); markup-safe
  acm heal                          Repair markup that renders raw; snapshot-first
  acm import <Google Docs URL|file.docx> [out.md]
                                     Google Docs/Word → CriticMarkup, including comments
  acm spell [list] [--json]         List flagged words: count, suggestions, line
  acm spell add <word…>             Keep words in your personal dictionary
  acm spell ignore <word…>          Stop flagging words in THIS doc only
  acm spell replace "<w>" "<fix>"   Fix every flagged <w> in the doc (case-preserving)
  acm spell suggest [word…]         One SUGGEST[g:spelling] card per flagged word
  acm history [n]                   The doc's version history (auto-recorded)
  acm decisions [n] [--json]        Durable accept/reject/resolve decision history
  acm restore <sha>                 Restore a history version (snapshots first)
    (verbs take --doc <file>, --author <name>; matching fails safe on ambiguity)

Edit options:
  --port <n>         Port to serve on (default 12000; auto-increments if busy)
  --allow-host <name> Also accept this remote host, e.g. a Tailscale name (repeatable;
                     default: ACM_ALLOWED_HOSTS, else this Mac's Tailscale name if up)
  --asset-root <dir> Folder images may load from (default: the doc's git repo, else its folder)
  --no-open          Don't auto-open the browser (also ACM_NO_OPEN=1; a set $BROWSER is the opener)
  -h, --help         Show this help`;

export function parseInvocation(
  argv: string[],
  isAgentVerb: (value?: string) => boolean,
): Invocation {
  const first = argv[0];
  if (first === undefined) return { kind: "overview" };
  if (first === "-h" || first === "--help") return { kind: "help" };
  if (first === "skill") return { kind: "legacy-skill" };
  if (isAgentVerb(first)) return { kind: "agent", verb: first, args: argv.slice(1) };
  if (first !== "edit") {
    if (!first.startsWith("-")) {
      return {
        kind: "error",
        message: `acm: unknown command or bare document path: ${first}\nUse: acm edit ${first}`,
      };
    }
    return {
      kind: "error",
      message: `acm: edit options require the edit command\nUse: acm edit [file.md] ${argv.join(" ")}`,
    };
  }

  const edit: EditInvocation = { kind: "edit", open: true };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h" || value === "--help") return { kind: "help" };
    if (value === "--no-open") {
      edit.open = false;
      continue;
    }
    if (value === "--port") {
      const raw = argv[index + 1];
      const port = Number(raw);
      if (raw === undefined || !Number.isInteger(port) || port < 0 || port > 65_535) {
        return { kind: "error", message: "acm edit: --port requires an integer from 0 to 65535" };
      }
      edit.port = port;
      index += 1;
      continue;
    }
    if (value === "--allow-host") {
      const raw = argv[index + 1];
      if (raw === undefined || raw.startsWith("-")) {
        return { kind: "error", message: "acm edit: --allow-host requires a host name" };
      }
      edit.allowHosts = [...(edit.allowHosts ?? []), raw];
      index += 1;
      continue;
    }
    if (value === "--asset-root") {
      const raw = argv[index + 1];
      if (raw === undefined || raw.startsWith("-")) {
        return { kind: "error", message: "acm edit: --asset-root requires a folder" };
      }
      edit.assetRoot = raw;
      index += 1;
      continue;
    }
    if (value.startsWith("-")) {
      return { kind: "error", message: `acm edit: unknown option ${value}` };
    }
    if (edit.file !== undefined) {
      return { kind: "error", message: "acm edit: pass one Markdown document at a time" };
    }
    edit.file = value;
  }
  return edit;
}
