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

Memory directories are normalized to mode `0700` and memory files to `0600`. Derived JSON/Markdown files and reports are replaced atomically; existing modes are preserved and new files default to private permissions. The memory store rejects a symlink at its own directory/file boundary rather than following it into an unrelated location.

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
3. Prepares query terms once, scans the cached latest heads once, and scores active records by lexical/path/symbol relevance. Record haystacks are cached with their parsed record objects, avoiding repeated lowercase/join work across context rebuilds.
4. Considers pinned active records and active work items, while keeping global pinned codebase notes scoped to matching prompts or project paths. Inactive records (`done`, `stale`, or `superseded`) are not injected even if still pinned.
5. Groups results into sections such as user preferences, project decisions, recipes, session recaps, and codebase notes.
6. Lightly polishes the display: command recipes are normalized/deduped, session recaps render as concise outcomes/topics, diagnostic recaps about inspecting injected context are suppressed/prunable, temp agent artifact and screenshot/media paths are hidden, file suffixes are capped with explicit “N more paths” wording, session recap file suffixes prefer project-local paths over package/docs paths, global technical notes need distinctive prompt/path matches, and user-scoped decisions/facts render in a separate global section.
7. Adds relevant repo-map matches when available. Automatic repo-map injection is stricter than `/hmemory-repo`: it requires a path-like match, an exact symbol/command/tool/hook match, or a configurable minimum number of distinctive non-generic query terms. Injected repo-map matches are labeled as potentially noisy/stale codebase search hints and filter low-value parser symbols.
8. Prepends a hidden custom message containing a capped `<hybrid_memory>` block through Pi's `context` hook instead of appending retrieved records to the system prompt. Budgeting is section-aware so high-value sections are not cut mid-record by lower-priority content; omitted tails are summarized with explicit lower-ranked record/match counts. The cap and per-section limits can be tuned with the local Pi `hybridMemory` settings object.

Mutating hooks, commands, and tools use Pi's file mutation queue plus deterministic user/project filesystem locks. The queue handles parallel tools in one Pi process; the filesystem locks extend the same transaction window across independent Pi processes without adding work to read-only prompt injection. Session import, compaction mining, doctor cleanup, model-audit application, and prune operations batch JSONL heads so summaries/context regenerate once per mutation batch rather than once per record.

The injected block explicitly says retrieved records are untrusted context and must not be treated as instructions unless the current user asks.

`/hmemory-explain <prompt>` and `hybrid_memory_explain` run the same selector read-only and return the bounded block plus candidate ids, kinds, scores, and pinned status. This makes retrieval behavior inspectable to both people and models without adding hidden tracing to every prompt.

## Runtime module boundaries

The package keeps `extensions/hybrid-memory.ts` as a stable two-line entrypoint. Runtime code is divided by responsibility:

- `registration.ts`, `register-commands.ts`, and `register-tools.ts` wire Pi without owning storage logic.
- `configuration.ts` owns bounded, stat-cached Pi settings and feature toggles.
- `foundation.ts` owns paths, private cached JSONL heads, and common mutation/storage primitives.
- `retrieval.ts` owns lexical scoring, search filtering, and record-path display rules.
- `repo-context.ts` owns repo discovery/maps, staleness, and generated project context.
- `sessions.ts`, `curation.ts`, and `lifecycle.ts` separate ingestion, deterministic cleanup, and orchestration.
- `presentation-retrieval.ts` owns selection, bounded injection, and TUI presentation.
- `command-args.ts` and `memory-purge.ts` isolate bounded CLI parsing and the explicit hard-delete path.
- `audit.ts` owns model packet generation, immutable constraints, action validation, and batched application; `audit-ui.ts` owns progress/review overlays.
- `extensions/core/` contains small domain, privacy, path, atomic-file, lock, and schema primitives.

Imports flow toward these focused services; the Pi entrypoint does not accumulate implementation logic. The source contract rejects runtime files over 650 lines so catchalls cannot quietly regrow.

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

Discovery uses NUL-delimited Git output. The non-Git fallback tracks visited directory inodes, skips symlinks, and tolerates disappearing/unreadable entries. Every candidate is checked lexically and by real path before reading. Persisted `repomap.json` is size-capped and schema-normalized again before display or injection, so manually damaged or hostile cache fields do not become prompt content.

When created through the remember tool, `codebase_note` records store lightweight file freshness evidence (`path`, `size`, `mtimeMs`) for referenced files. During pruning, active unpinned codebase notes are marked stale if a referenced file is missing or has changed relative to that evidence, falling back to record update time for older records. This keeps source files ahead of old memory claims.

## Model audit and cleanup

`/hmemory-audit` builds a bounded audit packet from active records, local hygiene flags, duplicate-subject hints, scope-review hints, preference-review hints, and repo-map freshness. The packet can be narrowed by scope, kind, focus query, and page/limit so large active sets can be reviewed in batches. The packet is redacted with the same best-effort secret redaction used for storage and injection.

The selected Pi model returns strict JSON with a short report plus structured actions. Supported actions are:

- `set_status` — mark records `stale`, `done`, or `superseded`
- `set_pinned` — pin or unpin records
- `update_record` — append a cleaner head for an existing record
- `create_record` — add a compact new record
- `merge_records` — create one clean superseding record and mark sources superseded

The packet snapshots each included record's scoped key, scope, kind, status, and `updatedAt`. Apply rejects off-packet targets, changed/inactive heads, cross-scope or cross-kind merges, and creates outside the packet's represented scopes/kinds. Valid actions are staged in memory and appended as one batch, avoiding repeated JSONL reads and summary/context regeneration. In the TUI, users can toggle individual proposed actions before apply; non-interactive apply can target numbered actions with `--actions`. Reports are saved in `<project>/.pi/hybrid-memory/audits/` and distinguish model actions from actual append-only record writes.

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

For privacy cleanup, `/hmemory-purge <scoped-id> --force` removes every parseable JSONL version of one identified `scope:id`, regardless of historical schema version. It refuses to proceed when a damaged line might contain the target, then publishes the replacement through fsync + atomic rename inside the cross-process mutation lock. Summaries/context regenerate and a small audit marker records the id/count only; purged content is never copied into the marker.

## Generated context

`context.md` is a compact project orientation file. It includes active user preferences, global user decisions/facts, project decisions/facts, work items, and repo-map highlights. It is regenerated after relevant writes and can be manually refreshed with `/hmemory-context`.
