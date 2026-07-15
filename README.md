[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/feveromo/pi-hybrid-memory)

# pi-hybrid-memory

Local-first, inspectable memory and repo context for Pi coding agents.

`pi-hybrid-memory` gives long-running AI coding workflows a small memory layer that maintainers can audit with normal tools. It is a Pi extension that plugs into Pi's hooks, commands, and tools. It stores durable preferences, project decisions, active work, session recaps, validation recipes, and codebase notes in JSONL/Markdown, then injects only a bounded, redacted, relevance-ranked context block into future Pi turns.

The goal is simple: help coding agents remember useful project context without turning old chat text into hidden authority.

## Why this matters

AI-assisted open-source maintenance depends on context: project decisions, security constraints, release checks, validation commands, and the small "we already learned this" details that get lost between sessions. Memory is also a trust boundary. If it is opaque, unbounded, stale, or full of secrets, it can make agents less safe instead of more useful.

This project explores a conservative path for agent memory:

- **Local-first by default** — no hosted service, daemon, vector database, or external graph database is required.
- **Human-inspectable storage** — memory is plain JSONL plus generated Markdown summaries.
- **Repo-aware retrieval** — lexical/path/symbol matching and a lightweight repo map keep context grounded in the current codebase.
- **Security-conscious injection** — retrieved memory is explicitly marked as untrusted context, not instructions.
- **Append-only maintenance** — normal cleanup marks records stale, done, or superseded instead of silently rewriting history.

## Security model at a glance

| Boundary | How it is handled |
| --- | --- |
| Local data | User memory lives in `~/.pi/agent/memory/`; project memory lives in `<project>/.pi/hybrid-memory/`. |
| Prompt injection | Retrieved records are wrapped in a `<hybrid_memory>` block that warns agents not to treat memory as instructions. |
| Secret handling | Text is redacted before storage and injection for common API keys, authorization headers, private-key blocks, token assignments, and sensitive path names. |
| Sensitive files | Repo maps exclude `.pi/`, `.git/`, `node_modules/`, common cache/build output, binary/archive/database files, and sensitive credential paths. |
| Context size | Prompt-time injection uses section-aware caps so memory stays bounded and reviewable. |
| Cleanup | `/hmemory-forget`, `/hmemory-doctor`, and `/hmemory-audit` append newer inactive heads; `/hmemory-purge <scoped-id> --force` is the explicit hard-delete escape hatch. |
| Model-assisted audit | `/hmemory-audit` is opt-in, sends a bounded best-effort-redacted packet to the selected Pi model/provider, validates structured actions, and writes an audit report. |

See [Security and privacy](docs/security-and-privacy.md) and [SECURITY.md](SECURITY.md) for more detail.

## Core workflows

- **Start work with context** — session startup initializes memory files, refreshes small repo maps, and imports current/recent local session recaps.
- **Orient future agents** — `<project>/.pi/hybrid-memory/context.md` keeps a compact project briefing with decisions, work items, and repo-map highlights.
- **Capture durable knowledge** — tools and commands store preferences, decisions, codebase notes, work items, and reusable validation/build recipes.
- **Keep memory clean** — `/hmemory-health`, `/hmemory-review`, `/hmemory-doctor`, `/hmemory-prune`, and `/hmemory-audit` make stale or noisy memory visible and actionable.
- **Bootstrap older projects** — `/hmemory-bootstrap` rebuilds the repo map, mines prior local Pi sessions, prunes duplicate recaps, and rolls up older history.

## Install

Install the package from GitHub:

```bash
pi install git:github.com/feveromo/pi-hybrid-memory
```

For local development, load a checkout as a Pi package:

```json
{
  "packages": [
    "<path-to-your-local-clone>/pi-hybrid-memory"
  ]
}
```

Then run `/reload`.

Project memory is written under `<project>/.pi/hybrid-memory/`. Add `.pi/` to that project's `.gitignore` if the project does not already ignore Pi runtime state.

## Validation

```bash
npm test
npm run validate
npm run release:check
```

`npm test` covers types, architecture, docs, security, behavior, retrieval quality, repo-map fixtures, and the 15k-record latency budget. `npm run validate` adds an isolated Pi package smoke-load. `npm run release:check` also audits dependencies and verifies the packed file inventory.

## Features

- JSONL + Markdown durable memory files, inspectable and editable.
- User scope: `~/.pi/agent/memory/`.
- Project scope: nearest project root `.pi/hybrid-memory/`.
- Lexical/path/symbol retrieval first; no vector DB or external service.
- Transient per-turn injection via Pi's `context` hook as a hidden custom message, capped by lean, Pi-settings-tunable section-aware budgets with global decisions/facts, stricter per-section limits, and light display polish/dedupe.
- Cheap session-start refresh: initialize memory, auto-build missing/stale repo maps for small projects, and ingest only the current/recent local sessions.
- Lightweight repo map cache in `<project>/.pi/hybrid-memory/repomap.json`, including tracked and untracked non-ignored files, symbols, imports, commands, tools, hooks, and exports, with bounded start/middle/end sampling for oversized source files.
- Compact working context in `<project>/.pi/hybrid-memory/context.md` for fast agent orientation.
- Conservative session import that stores compact session recaps, trimmed validation/build command recipes, and explicit user-stated preferences while skipping delegated-agent noise and temp artifacts.
- Configurable lightweight auto-capture for durable preference prompts as they are submitted, plus compact current-session import/pruning after each agent turn without live command-recipe churn.
- Secret/path redaction before records are stored or injected, including plain `sk-...`, `sk-ant-...`, and `sk-proj-...` style keys.
- Process-safe mutating hooks, commands, and tools via Pi's in-process queue plus ordered filesystem locks; batched JSONL appends regenerate summaries/context once per mutation batch.
- Cached latest-head reads and a single-pass prepared-query scorer keep prompt-time retrieval fast without a vector database; the checked-in 15k-record benchmark enforces relevance, context size, and warm p95 latency.
- Private `0700` memory directories and `0600` files, atomic derived-file/report replacement, symlink-resistant session/repo traversal, and schema-validated persisted repo maps.
- Codebase notes store lightweight file freshness evidence and are marked stale during pruning when referenced files are changed or removed.
- Opt-in model audit/cleanup through `/hmemory-audit`, using the selected Pi model to propose validated append-only memory changes like dedupe, merge, stale, pin, and rewrite.
- Pi compaction/branch summaries can be mined into durable memories through Pi session hooks.

## Documentation

- [Usage](docs/usage.md) — daily workflows, commands, and tool examples.
- [Architecture](docs/architecture.md) — storage model, hooks, repo maps, and prompt injection.
- [Configuration](docs/configuration.md) — package install, storage paths, startup behavior, and maintenance.
- [Development](docs/development.md) — project layout, validation, and contribution notes.
- [Security and privacy](docs/security-and-privacy.md) — redaction, untrusted injection, and local data handling.
- [Reference](docs/reference.md) — compact command/tool/record inventory.

## Tools

- `hybrid_memory_remember` — add a typed user/project memory record.
- `hybrid_memory_search` — search memory records, with optional scope/kind/status filters.
- `hybrid_memory_forget` — mark records `done`, `stale`, or `superseded`; optionally keep a tiny active `tombstone`/`tombstoneNote` preference for “do not suggest this again” cases.
- `hybrid_memory_doctor` — preview/apply deterministic cleanup candidates, scope hints, and low-context preference review hints, then write a curation report.
- `hybrid_memory_explain` — read-only preview of the exact bounded memory block plus ranked candidate ids/scores for a proposed prompt.
- `hybrid_memory_stats` — show memory counts and paths.
- `hybrid_memory_import_sessions` — import concise recaps/preferences from Pi session JSONL files.
- `hybrid_memory_refresh_context` — rebuild repo map and optionally import recent session recaps.
- `hybrid_memory_bootstrap_project` — one-time local backfill from prior project sessions, with prune/rollup.
- `hybrid_memory_build_repomap` — rebuild a lightweight project repo map.

## Commands

- `/hmemory` — show memory stats.
- `/hmemory-config` — show active hybrid-memory tuning from Pi settings.
- `/hmemory-toggle on|off [--global|--project]` — enable/disable automatic injection, auto-capture, auto-import, and agent-callable memory tools without deleting stored JSONL data.
- `/hmemory-search [--all] [--scope user|project] [--kind recipe] [--status stale] <query>` — search memory.
- `/hmemory-explain <prompt>` — preview and explain which memories would be candidates for that prompt without changing storage.
- `/hmemory-forget <id|query> [status]` — mark a memory stale/done/superseded; use `user:<id>` or `project:<id>` if ambiguous. If no id matches, it previews matching active records.
- `/hmemory-purge <scoped-id> --force` — hard-delete all JSONL versions of one memory and write a content-free audit marker.
- `/hmemory-repomap` — rebuild repo map for the current project.
- `/hmemory-repo <query>` — search repo map files/symbols/imports/commands/tools/hooks.
- `/hmemory-health` — show memory health, active/inactive counts, cleanup/review hints, and repo-map staleness.
- `/hmemory-doctor [preview|apply] [maxRecaps]` — write a curation report with safe cleanup candidates, scope hints, and optional append-only stale-status application.
- `/hmemory-show <id>` — show one memory record.
- `/hmemory-review` — review/pin/stale/done active memories in a TUI overlay.
- `/hmemory-audit [preview|apply] [--scope user|project] [--kind recipe] [--page N] [--limit N] [--actions 1,3] [focus]` — use the selected Pi model plus local doctor-style hints to audit, clean, dedupe, merge, pin/unpin, and rewrite memory through validated append-only changes.
- `/hmemory-prune [maxActiveRecaps]` — mark duplicate/old session recaps stale and optionally create a rollup.
- `/hmemory-dashboard [full]` — open a styled TUI overlay with memory/repo health; `full` shows command/tool details.
- `/hmemory-context` — regenerate/show the compact working context file.
- `/hmemory-work <description>` — create an active project work item.
- `/hmemory-done <id>` — mark a memory/work item done.
- `/hmemory-pin <id>` / `/hmemory-unpin <id>` — prioritize active memories for retrieval/injection; inactive pinned records stay suppressed.
- `/hmemory-ingest-session [current|recent N|/path/session.jsonl]` — populate memory from sessions.
- `/hmemory-refresh [N]` — rebuild repo map and ingest the current + N recent project sessions.
- `/hmemory-bootstrap [maxSessions]` — one-time deeper project backfill: rebuild repo map, scan prior project sessions, prune duplicates, and roll up old recaps.
- `/hmemory-files` — show storage paths.

## Files

```text
~/.pi/agent/memory/
  records.jsonl
  summary.md
  state.json

<project>/.pi/hybrid-memory/
  records.jsonl
  summary.md
  active.json   # generated active-work index
  context.md
  repomap.json
  audits/      # audit, doctor, and purge marker reports
  state.json
```

## Project status

`pi-hybrid-memory` is pre-1.0 but has strict type checking, architecture/docs/security/behavior/privacy contracts, a black-box injection-quality harness, a 15k-record latency benchmark, isolated package smoke loading, and Node 22/24 CI. The stable Pi entrypoint is intentionally tiny; storage, repo context, sessions, curation, retrieval/presentation, audit, lifecycle, commands, and tools live in focused modules.

It remains intentionally simple at runtime: no vector DB, daemon, or external service by default. `/hmemory-audit` is explicit and uses the selected Pi model/provider with an immutable, redacted, bounded packet and validated batched actions. Normal curation remains append-only; `/hmemory-purge <scoped-id> --force` is the explicit atomic hard-delete escape hatch. Startup and turn refreshes stay bounded; use `/hmemory-bootstrap` for deeper historical backfills.
