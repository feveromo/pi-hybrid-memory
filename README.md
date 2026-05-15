# pi-hybrid-memory

Local-first hybrid memory for Pi.

It provides a small, inspectable memory layer for Pi agents:

- JSONL + Markdown durable memory files, inspectable and editable.
- User scope: `~/.pi/agent/memory/`.
- Project scope: nearest project root `.pi/hybrid-memory/`.
- Lexical/path/symbol retrieval first; no vector DB or external service.
- Transient per-turn injection via `before_agent_start`, capped by lean, Pi-settings-tunable budgets with stricter per-section limits.
- Cheap session-start refresh: initialize memory, auto-build missing/stale repo maps for small projects, and ingest only the current/recent local sessions.
- Lightweight repo map cache in `<project>/.pi/hybrid-memory/repomap.json`, including tracked and untracked non-ignored files, symbols, imports, commands, tools, hooks, and exports.
- Compact working context in `<project>/.pi/hybrid-memory/context.md` for fast agent orientation.
- Conservative session import that stores compact session recaps, trimmed validation/build command recipes, and explicit user-stated preferences while skipping delegated-agent noise.
- Lightweight auto-capture for durable preference prompts as they are submitted, plus compact current-session import/pruning after each agent turn.
- Secret/path redaction before records are stored or injected, including plain `sk-...`, `sk-ant-...`, and `sk-proj-...` style keys.
- Retrieved memory is injected as untrusted context, not high-priority instructions.
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
- `hybrid_memory_search` — search memory records.
- `hybrid_memory_forget` — mark records `done`, `stale`, or `superseded`.
- `hybrid_memory_stats` — show memory counts and paths.
- `hybrid_memory_import_sessions` — import concise recaps/preferences from Pi session JSONL files.
- `hybrid_memory_refresh_context` — rebuild repo map and optionally import recent session recaps.
- `hybrid_memory_bootstrap_project` — one-time local backfill from prior project sessions, with prune/rollup.
- `hybrid_memory_build_repomap` — rebuild a lightweight project repo map.

## Commands

- `/hmemory` — show memory stats.
- `/hmemory-config` — show active hybrid-memory tuning from Pi settings.
- `/hmemory-search <query>` — search memory.
- `/hmemory-forget <id> [status]` — mark a memory stale/done/superseded; use `user:<id>` or `project:<id>` if ambiguous.
- `/hmemory-repomap` — rebuild repo map for the current project.
- `/hmemory-repo <query>` — search repo map files/symbols/imports/commands/tools/hooks.
- `/hmemory-health` — show memory health, duplicate hints, and repo-map staleness.
- `/hmemory-show <id>` — show one memory record.
- `/hmemory-review` — review/pin/stale/done active memories in a TUI overlay.
- `/hmemory-prune [maxActiveRecaps]` — mark duplicate/old session recaps stale and optionally create a rollup.
- `/hmemory-dashboard [full]` — open a styled TUI overlay with memory/repo health; `full` shows command/tool details.
- `/hmemory-widget [off]` — show/hide a compact memory widget above the editor.
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
  state.json
```

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
npm run test:fixture
npm run smoke:load
npm run validate
```

## Notes / future work

Still intentionally simple: no vector DB, no external service, and no automatic pruning daemon. Startup/turn auto-refresh is deliberately bounded, compact, local, and lightly configurable through Pi settings; use `/hmemory-bootstrap` for deeper historical backfills. Future hardening could add stale-codebase-note invalidation tied to file mtimes.
