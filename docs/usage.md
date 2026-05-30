# Usage

`pi-hybrid-memory` gives Pi a small, local memory layer backed by JSONL files and a lightweight repo map. It is designed to be inspectable, editable, and easy to disable or prune.

## Daily workflow

### Check memory status

```text
/hmemory
/hmemory-health
/hmemory-doctor preview
/hmemory-dashboard
/hmemory-config
```

Use `/hmemory-dashboard full` when you want command/tool/hook details from the repo map. Use `/hmemory-config` to inspect the active tuning loaded from Pi settings. `/hmemory` and `/hmemory-health` show active vs inactive counts so append-only history is not confused with useful current memory.

### Temporarily disable memory

```text
/hmemory-toggle off
/hmemory-toggle on
/hmemory-toggle off --project
/hmemory-toggle status
```

Turning memory off disables automatic injection, auto-capture, current-session auto-import, compaction/branch mining, and agent-callable `hybrid_memory_*` tools. It does not delete JSONL records, and slash commands stay available for inspection or re-enabling.

### Search memory

```text
/hmemory-search architecture
/hmemory-search --scope user --kind preference concise answers
/hmemory-search --all --status superseded old prompt
/hmemory-show <id>
```

If an id exists in both user and project scope, use a scoped id such as `user:<id>` or `project:<id>`. Search defaults to active memories; add `--all` or `--status stale|done|superseded` when auditing old append-only history.

### Add active work

```text
/hmemory-work finish docs for hybrid memory
/hmemory-done <id>
```

Active work items are project-scoped and are included in future memory injection until marked done/stale/superseded.

### Pin or unpin important records

```text
/hmemory-pin <id>
/hmemory-unpin <id>
```

Pinned active records are favored during retrieval and shown before lower-salience records. Marking a pinned record `done`, `stale`, or `superseded` suppresses it from retrieval, injection, summaries, and the review overlay.

### Mark bad or obsolete memory

```text
/hmemory-forget <id>
/hmemory-forget <id> stale
/hmemory-forget <id> done
/hmemory-forget <id> superseded
/hmemory-forget obsolete package
```

Records are append-only: status changes append a new latest version rather than rewriting history. In plain terms, “forget” means the record becomes inactive and stops being injected or returned by default search; it is not a hard delete of the JSONL history. If you pass a query instead of an id, Pi previews matching active records and tells you which scoped id to use.

For privacy cleanup, use the explicit hard-delete escape hatch:

```text
/hmemory-purge project:<id> --force
/hmemory-purge user:<id> --force
```

Purge rewrites the relevant `records.jsonl` to remove all versions of that one scoped id, regenerates summaries/context, and writes a content-free audit marker. It intentionally does not log the purged content.

### Run deterministic curation

```text
/hmemory-doctor preview
/hmemory-doctor apply
/hmemory-doctor apply 8
```

`/hmemory-doctor` is the local, no-model curation pass. It writes a report under `<project>/.pi/hybrid-memory/audits/` with:

- active/inactive counts by scope/status
- duplicate subject groups
- noisy imported preference/recipe/session candidates
- old session recap candidates
- user/project scope review hints
- before/after counts when applying

Preview mode never changes records. Apply mode only appends `stale` statuses for deterministic hygiene candidates; it does not rewrite, merge, move scopes, or delete anything. Use `/hmemory-audit` when you want the selected Pi model to propose rewrites, merges, new clean records, or pinned changes.

### Review records in the TUI

```text
/hmemory-review
```

Keys inside the review overlay:

- `j` / down arrow — next record
- `k` / up arrow — previous record
- `p` — pin selected record
- `u` — unpin selected record
- `s` — mark stale
- `d` — mark done
- `q` / escape — close

### Let the selected Pi model clean memory

```text
/hmemory-audit
/hmemory-audit preview
/hmemory-audit apply
/hmemory-audit --scope project --kind session_recap --page 2
/hmemory-audit apply --actions 1,3 session recaps
```

The command sends a bounded, redacted packet of active memory records to the currently selected Pi model. The model returns a structured cleanup plan. The extension validates the plan and applies only append-only changes: mark stale/done/superseded, pin/unpin, rewrite a record head, create a clean record, or merge duplicates into a new superseding record.

Use `--scope`, `--kind`, `--page`, and `--limit` to audit a smaller batch when the active set is large. Reports distinguish proposed model actions from actual append-only record writes, because one merge action can create one record and update several source records.

In interactive TUI mode, `/hmemory-audit` opens an action review overlay so you can toggle individual proposed actions before applying. Use `preview` for report-only, `apply` to skip confirmation, or `apply --actions 1,3` to apply only specific numbered actions. Reports are saved under:

```text
<project>/.pi/hybrid-memory/audits/
```

## Repo-map workflow

The repo map indexes file paths, file kinds, imports, symbols, commands, tools, hooks, and exports for small/medium projects.

```text
/hmemory-repomap
/hmemory-repo registerTool
/hmemory-repo hmemory-dashboard
/hmemory-context
```

The injected memory block warns when the repo map is stale. Run `/hmemory-repomap` or `/hmemory-refresh` after meaningful code changes. Automatic repo-map injection is stricter than manual `/hmemory-repo`: generic prompts are ignored unless they contain a path-like term, exact symbol/command/tool/hook match, or enough distinctive non-generic terms. Injected repo-map matches are labeled as codebase search hints because they may be noisy or stale, and low-value parser symbols are filtered from display.

## Session import workflow

Use session imports to mine compact recaps, reusable command recipes, and explicit durable preferences from local Pi session JSONL files.

```text
/hmemory-ingest-session current
/hmemory-ingest-session recent 10
/hmemory-ingest-session /path/to/session.jsonl
/hmemory-refresh 5
/hmemory-bootstrap 250
```

Recommended use:

- Use `/hmemory-refresh` for routine updates.
- Use `/hmemory-bootstrap` once when opening an older project with useful session history.
- Use `/hmemory-prune` when session recap noise accumulates. It also marks obvious pasted-review preferences, delegated subagent recaps, generic command-only recipes, and command recipes covered by newer/pinned recipes stale.
- Pruning also marks unpinned `codebase_note` records stale when their referenced source files are changed or removed. Codebase notes created through `hybrid_memory_remember` store lightweight file freshness evidence to make this more reliable.

Prompt injection also does a small presentation pass: near-identical command recipes are deduped, session recaps are shown as outcomes/topics, diagnostic recaps about inspecting injected context are suppressed/prunable, temp agent artifact and screenshot/media paths are hidden, session recap file suffixes prefer project-local paths over package/docs paths, user-scoped decisions/facts get a global section, and global pinned technical notes stay out of unrelated projects unless the prompt has a distinctive match.

## Tool examples

Agents can use the registered tools directly:

```json
{
  "scope": "project",
  "kind": "decision",
  "subject": "local-first architecture",
  "content": "Keep pi-hybrid-memory local-first and Pi-native; avoid external services by default.",
  "tags": ["architecture"],
  "salience": 4,
  "pinned": true
}
```

Useful tools:

- `/hmemory-audit` for model-assisted cleanup and organization
- `hybrid_memory_remember`
- `hybrid_memory_search`
- `hybrid_memory_forget` — use optional `tombstone: true` plus `tombstoneNote` when retiring details but keeping a small “do not suggest this again” preference
- `hybrid_memory_import_sessions`
- `hybrid_memory_refresh_context`
- `hybrid_memory_bootstrap_project`
- `hybrid_memory_stats`
- `hybrid_memory_build_repomap`

## Generated files to inspect

```text
~/.pi/agent/memory/summary.md
<project>/.pi/hybrid-memory/summary.md
<project>/.pi/hybrid-memory/context.md
<project>/.pi/hybrid-memory/repomap.json
<project>/.pi/hybrid-memory/audits/*.md
```

These files are intentionally human-readable so you can audit what will influence future turns.
