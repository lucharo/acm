# Documentation index

One row per doc. `Class` is the confirmed classification: evergreen docs track the current code and get fixed when they drift; point-in-time docs are true as of their date and are never rewritten to match the code. `Owns` lists the path globs whose facts the doc owns (`—` for none). The terminology dictionary is `CONTEXT.md`. This file is not part of the built site; `docs/index.md` is the site landing page.

<!-- doc-index:begin -->
| Doc | What | Class | Owns |
| --- | --- | --- | --- |
| `README.md` | Landing page on GitHub: what ACM is, install, links into the docs | evergreen | `package.json` |
| `CONTEXT.md` | Glossary: the one name for each concept | evergreen | — |
| `CLAUDE.md` | Conventions for agents changing ACM: compiled-binary embeds, NUL bytes | evergreen | `scripts/gen-embedded*.ts`, `scripts/build-bin.ts` |
| `skills/acm-review/SKILL.md` | The agent skill: markup, verbs, workflow | evergreen | `src/cli/verbs.ts`, `src/lib/agentEdits.ts` |
| `docs/index.md` | Site landing page | evergreen | — |
| `docs/getting-started.md` | Install, open a document, first agent review, update, import | evergreen | `scripts/setup.ts`, `src/cli/invocation.ts`, `src/cli/docxImport.ts` |
| `docs/reviewing.md` | The editor: cards, decisions, groups, keyboard, editing, print | evergreen | `src/components/**`, `src/App.tsx`, `src/lib/shortcuts.ts` |
| `docs/agents.md` | Pointing an agent at a document; write safety; HTTP endpoints | evergreen | `server.ts` |
| `docs/cli.md` | Every `acm` command and option | evergreen | `cli.ts`, `src/cli/**` |
| `docs/syntax.md` | CriticMarkup as ACM reads it | evergreen | `src/lib/criticmarkup.ts` |
| `docs/troubleshooting.md` | Error messages and their fixes | evergreen | `scripts/setup.ts`, `src/cli/verbs.ts`, `server.ts` |
| `docs/maintainers.md` | Build, test, rules, code map, shipping, docs | evergreen | `package.json`, `justfile`, `scripts/**`, `.github/workflows/**` |
| `docs/adr/*.md` | Architecture decisions | point-in-time | — |
| `visual-test.md` | Visual QA fixture document | point-in-time | — |
<!-- doc-index:end -->
