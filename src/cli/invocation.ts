export interface EditInvocation {
  kind: "edit";
  file?: string;
  /** `acm skill`: open the user's review preferences. */
  reviewSkill?: boolean;
  port?: number;
  /** Folder relative images may reach (default: the doc's git repo, else its folder). */
  assetRoot?: string;
  /** Remote host names to accept besides loopback (repeatable --allow-host). */
  allowHosts?: string[];
  open: boolean;
  /** #31: --notify prints a line per wake while the editor runs; --wait exits on the first. */
  listen?: "notify" | "wait";
}

export type Invocation =
  | { kind: "overview" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "agent"; verb: string; args: string[] }
  | { kind: "verb-help"; text: string }
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
  acm --help               Show every command and option
  acm --version            Print the installed version`;

export const HELP_TEXT = `acm — Agent CriticMarkup editor

Usage:
  acm                         Explain ACM and list the main commands
  acm edit                    Open the New / Open / Recent Documents launcher
  acm edit <file.md>          Open the file, creating it if missing
  acm skill                   Open your acm-user-preferences skill
  acm edit <file.md> --notify Also print one stdout line each time the person hands
                              the agent work (a comment, Ask agent to edit, Send to
                              agent); attaches to an editor already open on the file
  acm edit <file.md> --wait   Exit with the first such line (at once if work is
                              already pending); the editor keeps running

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
  -h, --help         Show this help
  -v, --version      Print the installed version`;

const VERB_OPTIONS = `Options:
  --doc <file.md>    The document (else $ACM_DOC, else the doc open in the running ACM editor)
  --author <name>    Who the comment or decision is from (default: $ACM_AUTHOR, else claude)
  --group <id>       comment, suggest: tag a set; accept, reject: act on the whole set
  --json             threads, spell list, decisions: machine-readable output
  --                 End of options: text after it may start with --
  (--doc, --author and --group also take --flag=value; every write snapshots the doc first)`;

/** \`acm <verb> --help\` (#117): the verb's lines from HELP_TEXT, then the options
 *  the verbs share. One source of truth, so the two helps can't drift. */
export function verbHelp(verb: string): string {
  const lines = HELP_TEXT.split("\n");
  const usage: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp(`^  acm ${verb}( |$)`).test(lines[i])) continue;
    usage.push(lines[i]);
    while (i + 1 < lines.length && /^ {6,}\S/.test(lines[i + 1]) && !/^\s+acm /.test(lines[i + 1])) usage.push(lines[++i]);
  }
  if (usage.length === 0) return HELP_TEXT; // e.g. the deprecated `apply`
  // import writes a new file of its own (positional out.md): no --doc, no snapshot.
  if (verb === "import") return `Usage:\n${usage.join("\n")}`;
  return `Usage:\n${usage.join("\n")}\n\n${VERB_OPTIONS}`;
}

export function parseInvocation(
  argv: string[],
  isAgentVerb: (value?: string) => boolean,
): Invocation {
  const first = argv[0];
  if (first === undefined) return { kind: "overview" };
  if (first === "-h" || first === "--help") return { kind: "help" };
  if (first === "-v" || first === "--version") return { kind: "version" };
  if (isAgentVerb(first)) {
    const args = argv.slice(1);
    const flags = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
    if (flags.includes("--help") || flags.includes("-h")) return { kind: "verb-help", text: verbHelp(first) };
    return { kind: "agent", verb: first, args };
  }
  if (first !== "edit" && first !== "skill") {
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
  if (first === "skill") edit.reviewSkill = true;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h" || value === "--help") return { kind: "help" };
    if (value === "-v" || value === "--version") return { kind: "version" };
    if (value === "--no-open") {
      edit.open = false;
      continue;
    }
    if (value === "--notify" || value === "--wait") {
      const mode = value === "--notify" ? "notify" : "wait";
      if (edit.listen && edit.listen !== mode) {
        return { kind: "error", message: "acm edit: use --notify or --wait, not both" };
      }
      edit.listen = mode;
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
    if (edit.reviewSkill) {
      return { kind: "error", message: "acm skill: takes no document; it opens your review preferences" };
    }
    if (edit.file !== undefined) {
      return { kind: "error", message: "acm edit: pass one Markdown document at a time" };
    }
    edit.file = value;
  }
  if (edit.listen && (edit.reviewSkill || edit.file === undefined)) {
    const verb = edit.reviewSkill ? "skill" : "edit";
    return {
      kind: "error",
      message: `acm ${verb}: --${edit.listen} needs a document: acm edit <file.md> --${edit.listen}`,
    };
  }
  return edit;
}
