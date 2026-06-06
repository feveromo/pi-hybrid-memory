# Architecture

`pi-hybrid-memory` is intentionally small and Pi-native. It avoids a vector database, graph database, daemon, or hosted service by default.

## Design goals

- Local-first: memory is stored in files on disk.
- Inspectable: JSONL records and Markdown summaries can be read and edited.
- Bounded: session import and prompt injection are compact by default.
- Conservative: only durable-looking preferences and compact recaps are auto-mined.
- Untrusted: retrieved memory is injected as context, not as instructions.
- Repo-aware: a lightweight repo map helps retrieval without heavyweight indexing.
- Model-assisted but controlled: `/hmemory-audit` can clean and organize memory through validated append-only actions.

## Storage model

There are two scopes:

```text
~/.pi/agent/memory/          # user scope
<project>/.pi/hybrid-memory/ # project scope
```

Each scope stores append-only `records.jsonl` plus generated summaries/state. Project scope also stores active work, a repo map, and a compact working context. In-process read-through caches keyed by file size/mtime keep prompt-time latest-head retrieval from reparsing unchanged JSONL files.

A memory record has:

- `id`
- `scope`: `user` or `project`
- `kind`: `preference`, `decision`, `project_fact`, `codebase_note`, `recipe`, `work_item`, or `session_recap`
- `subject` and `content`
- optional `tags`, `filePaths`, `symbols`, `evidence`, and `supersedes`
- `status`: `active`, `done`, `superseded`, or `stale`
- `salience` from 1 to 5
- optional `pinned`
- timestamps

Status updates append a newer version of the same `scope:id`. Retrieval uses the latest version. Model-audit cleanup uses the same append-only path; merges create a new record and mark source records `superseded` rather than deleting them.

## Project root detection

The project root is found by walking upward from the current working directory and stopping at a directory with `.git`, `package.json`, or Pi project markers. Project memory is stored under that root.

## Retrieval and injection

Before an agent starts, the extension auto-captures durable preference prompts. At LLM context-build time, the extension:

1. Removes any older `hybrid-memory-context` custom message so repeated context rebuilds do not accumulate duplicate memory blocks.
2. Redacts secrets from the latest user prompt used for matching.
3. Scores active records by lexical/path/symbol relevance.
4. Considers pinned active records and active work items, while keeping global pinned codebase notes scoped to matching prompts or project paths. Inactive records (`done`, `stale`, or `superseded`) are not injected even if still pinned.
5. Groups results into sections such as user preferences, project decisions, recipes, session recaps, and codebase notes.
6. Lightly polishes the display: command recipes are normalized/deduped, session recaps render as concise outcomes/topics, diagnostic recaps about inspecting injected context are suppressed/prunable, temp agent artifact and screenshot/media paths are hidden, file suffixes are capped with explicit “N more paths” wording, session recap file suffixes prefer project-local paths over package/docs paths, global technical notes need distinctive prompt/path matches, and user-scoped decisions/facts render in a separate global section.
7. Adds relevant repo-map matches when available. Automatic repo-map injection is stricter than `/hmemory-repo`: it requires a path-like match, an exact symbol/command/tool/hook match, or a configurable minimum number of distinctive non-generic query terms. Injected repo-map matches are labeled as potentially noisy/stale codebase search hints and filter low-value parser symbols.
8. Prepends a hidden custom message containing a capped `<hybrid_memory>` block through Pi's `context` hook instead of appending retrieved records to the system prompt. Budgeting is section-aware so high-value sections are not cut mid-record by lower-priority content; omitted tails are summarized with explicit lower-ranked record/match counts. The cap and per-section limits can be tuned with the local Pi `hybridMemory` settings object.

Mutating hybrid-memory hooks, commands, and tools use Pi's file mutation queue so parallel/local writes serialize JSONL appends and regenerated summaries/context. Session import, compaction mining, doctor cleanup, and prune operations batch record appends so summaries/context are regenerated once per batch rather than once per record.

The injected block explicitly says retrieved records are untrusted context and must not be treated as instructions unless the current user asks.

## Repo map

The repo map is saved to:

```text
<project>/.pi/hybrid-memory/repomap.json
```

It indexes tracked files and untracked non-ignored files, excluding `.pi/`, `.git/`, `node_modules/`, noisy home/cache paths, common binary/archive/database files, and sensitive paths.

For each mappable file it records:

- relative path
- file kind
- imports
- symbols
- registered Pi commands/tools/hooks where detectable
- exports
- size

The map is used for `/hmemory-repo`, `context.md`, dashboard summaries, and prompt-time repo matches. Repo-map file and read-size caps are configurable through Pi settings while remaining bounded by safe min/max ranges. Oversized source files are still sampled with bounded start/middle/end reads so important imports, mid-file symbols, and late command/tool/hook registrations are not silently lost when one file is over the read cap.

When created through the remember tool, `codebase_note` records store lightweight file freshness evidence (`path`, `size`, `mtimeMs`) for referenced files. During pruning, active unpinned codebase notes are marked stale if a referenced file is missing or has changed relative to that evidence, falling back to record update time for older records. This keeps source files ahead of old memory claims.

## Model audit and cleanup

`/hmemory-audit` builds a bounded audit packet from active records, local hygiene flags, duplicate-subject hints, scope-review hints, preference-review hints, and repo-map freshness. The packet can be narrowed by scope, kind, focus query, and page/limit so large active sets can be reviewed in batches. The packet is redacted with the same best-effort secret redaction used for storage and injection.

The selected Pi model returns strict JSON with a short report plus structured actions. Supported actions are:

- `set_status` — mark records `stale`, `done`, or `superseded`
- `set_pinned` — pin or unpin records
- `update_record` — append a cleaner head for an existing record
- `create_record` — add a compact new record
- `merge_records` — create one clean superseding record and mark sources superseded

The extension validates ids, scopes, kinds, statuses, and field sizes before applying. In the TUI, users can toggle individual proposed actions before apply; non-interactive apply can target numbered actions with `--actions`. Reports are saved in `<project>/.pi/hybrid-memory/audits/` and distinguish model actions from actual append-only record writes.

## Hooks

The extension uses Pi hooks to keep context fresh. Mutating hooks run inside the same memory mutation queue as commands/tools:

- `session_start` — initialize files, run a cheap startup refresh, maybe build a small repo map, import current/recent project sessions, and update the status chrome.
- `before_agent_start` — auto-capture durable preference prompts and keep tool state/chrome current.
- `context` — inject relevant memory as one hidden, labeled custom context message without permanently modifying the system prompt.
- `agent_end` — import the current session compactly and prune old session recap noise, delegated-session artifacts, generic command recipes, and obvious pasted-review preference captures. Current live-session import skips command-recipe creation to avoid rewriting a growing recipe every turn; explicit/recent/bootstrap imports still mine useful command recipes.
- `session_compact` — mine compaction summaries for decisions, preferences, and work items.
- `session_tree` — mine branch summaries similarly.

## Hard-delete escape hatch

Normal curation is append-only. `/hmemory-forget`, `/hmemory-doctor`, and `/hmemory-audit` do not physically delete record history.

For privacy cleanup, `/hmemory-purge <scoped-id> --force` rewrites the relevant `records.jsonl` file to remove every version of one identified `scope:id`, regenerates summaries/context, and writes a small audit marker that records the id and count only. The purged record content is intentionally not copied into the audit marker.

## Generated context

`context.md` is a compact project orientation file. It includes active user preferences, global user decisions/facts, project decisions/facts, work items, and repo-map highlights. It is regenerated after relevant writes and can be manually refreshed with `/hmemory-context`.
