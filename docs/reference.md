# Command and tool reference

This page is a compact inventory. See [Usage](usage.md) for workflows.

## Commands

| Command | Purpose |
| --- | --- |
| `/hmemory` | Show memory stats and storage roots. |
| `/hmemory-config` | Show active hybrid-memory tuning from Pi settings. |
| `/hmemory-toggle on\|off [--global\|--project]` | Enable/disable automatic injection/capture/import and agent-callable memory tools without deleting JSONL data. |
| `/hmemory-search [--all] [--scope user\|project] [--kind recipe] [--status stale] <query>` | Search memory records, defaulting to active records unless a status/all flag is provided. |
| `/hmemory-explain <prompt>` | Read-only preview of the bounded injected block plus ranked candidate ids/scores for a prompt. |
| `/hmemory-show <id>` | Show one memory record. |
| `/hmemory-forget <id\|query> [status]` | Mark a memory `stale`, `done`, or `superseded`; non-id text previews matching active records. |
| `/hmemory-purge <scoped-id> --force` | Hard-delete all JSONL versions of one scoped memory and write a content-free audit marker. |
| `/hmemory-done <id>` | Mark a memory/work item done. |
| `/hmemory-pin <id>` | Pin an active memory record for prioritized retrieval. |
| `/hmemory-unpin <id>` | Unpin a memory record. |
| `/hmemory-work <description>` | Create an active project work item. |
| `/hmemory-review` | Review/pin/stale/done records in a TUI overlay. |
| `/hmemory-audit [preview|apply] [--scope user\|project] [--kind recipe] [--page N] [--limit N] [--actions 1,3] [focus]` | Use the selected Pi model plus local doctor-style hints to audit, clean, dedupe, merge, pin/unpin, and rewrite memory through validated append-only changes. |
| `/hmemory-prune [maxActiveRecaps]` | Prune duplicate/old session-recapped memories and maybe create a rollup. |
| `/hmemory-repomap` | Rebuild the repo map for the current project. |
| `/hmemory-repo <query>` | Search repo-map files, symbols, imports, commands, tools, and hooks. |
| `/hmemory-health` | Show memory health, active/inactive counts, duplicate hints, cleanup candidate counts, scope/preference review hints, and repo-map staleness. |
| `/hmemory-doctor [preview\|apply] [maxRecaps]` | Write a deterministic curation report with safe cleanup candidates plus scope/preference review hints; optionally append stale statuses for safe cleanup candidates. |
| `/hmemory-dashboard [full]` | Open a styled memory/repo dashboard overlay. |
| `/hmemory-context` | Regenerate/show the compact working context file. |
| `/hmemory-ingest-session [current\|recent N\|path]` | Import memory from Pi session JSONL files. |
| `/hmemory-refresh [N]` | Rebuild repo map and import current + N recent project sessions. |
| `/hmemory-bootstrap [maxSessions]` | One-time deeper project backfill from prior sessions. |
| `/hmemory-files` | Show storage paths. |

## Tools

| Tool | Purpose |
| --- | --- |
| `hybrid_memory_remember` | Store a typed user/project memory record. |
| `hybrid_memory_search` | Search local memory records by lexical/path/symbol relevance, with optional scope/kind/status filters. |
| `hybrid_memory_forget` | Mark a memory record done, stale, or superseded; optional `tombstone`/`tombstoneNote` preserves a small active “do not suggest this again” preference. |
| `hybrid_memory_import_sessions` | Import compact memory from Pi session JSONL files. |
| `hybrid_memory_refresh_context` | Rebuild repo map and optionally import recent session recaps. |
| `hybrid_memory_bootstrap_project` | Rebuild repo map, import prior project sessions, prune, and roll up. |
| `hybrid_memory_stats` | Show active/inactive counts by scope/status/kind, hygiene hints, and paths. |
| `hybrid_memory_doctor` | Preview/apply deterministic cleanup candidates and write a curation report with scope/preference review hints. |
| `hybrid_memory_explain` | Read-only retrieval diagnostic showing the bounded block and ranked candidate metadata for a prompt. |
| `hybrid_memory_build_repomap` | Build or refresh the repo map. |

## Record kinds

- `preference`
- `decision`
- `project_fact`
- `codebase_note`
- `recipe`
- `work_item`
- `session_recap`

## Status values

- `active`
- `done`
- `superseded`
- `stale`
