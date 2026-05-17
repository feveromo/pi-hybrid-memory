# Usage

`pi-hybrid-memory` gives Pi a small, local memory layer backed by JSONL files and a lightweight repo map. It is designed to be inspectable, editable, and easy to disable or prune.

## Daily workflow

### Check memory status

```text
/hmemory
/hmemory-health
/hmemory-dashboard
/hmemory-config
```

Use `/hmemory-dashboard full` when you want command/tool/hook details from the repo map. Use `/hmemory-config` to inspect the active tuning loaded from Pi settings.

### Search memory

```text
/hmemory-search architecture
/hmemory-search user preference
/hmemory-show <id>
```

If an id exists in both user and project scope, use a scoped id such as `user:<id>` or `project:<id>`.

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
```

Records are append-only: status changes append a new latest version rather than rewriting history.

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
/hmemory-audit apply session recaps
```

The command sends a bounded, redacted packet of active memory records to the currently selected Pi model. The model returns a structured cleanup plan. The extension validates the plan and applies only append-only changes: mark stale/done/superseded, pin/unpin, rewrite a record head, create a clean record, or merge duplicates into a new superseding record.

In interactive mode, `/hmemory-audit` asks before applying. Use `preview` for report-only, or `apply` to skip confirmation. Reports are saved under:

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

The injected memory block warns when the repo map is stale. Run `/hmemory-repomap` or `/hmemory-refresh` after meaningful code changes.

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
- Pruning also marks unpinned `codebase_note` records stale when their referenced source files are changed or removed.

Prompt injection also does a small presentation pass: near-identical command recipes are deduped, session recaps are shown as outcomes/topics, diagnostic recaps about inspecting injected context are suppressed/prunable, temp agent artifact and screenshot/media paths are hidden, and global pinned technical notes stay out of unrelated projects unless the prompt has a distinctive match.

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
- `hybrid_memory_forget`
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
