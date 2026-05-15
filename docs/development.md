# Development

## Project layout

```text
extensions/hybrid-memory.ts  # Pi extension, commands, tools, hooks, storage, repo map
scripts/test.mjs             # source-level regression checks
scripts/fixture-test.mjs     # fixture-style behavior checks
README.md                    # quick overview
docs/                        # detailed documentation
```

## Validation

Run the fast tests while editing:

```bash
npm test
npm run test:fixture
```

`npm test` includes source checks, behavior tests, and a bounded large-repo repo-map smoke test.

Run the full local validation before handing off larger changes:

```bash
npm run validate
```

`npm run validate` runs:

```bash
npm test && npm run test:fixture && npm run smoke:load
```

`smoke:load` asks Pi to load this package and run `/hmemory-health` without a normal session.

## Development principles

- Keep the extension local-first and Pi-native.
- Prefer JSONL/Markdown files over opaque databases.
- Keep startup and per-turn work bounded.
- Treat memory as untrusted context, not instructions.
- Redact secrets before storing or injecting text.
- Avoid indexing generated `.pi/` project state in the repo map.
- Keep command and tool output concise enough for Pi notifications.

## Editing records during development

Memory files are append-only. To change a record programmatically, append a newer version with the same `scope:id`. For user-facing maintenance, prefer existing commands/tools such as `/hmemory-forget`, `/hmemory-done`, `/hmemory-pin`, and `hybrid_memory_forget`.

If manual edits damage a JSONL line, the reader skips that line rather than failing the entire file.

## Adding commands or tools

When adding a command/tool:

1. Register it in `extensions/hybrid-memory.ts`.
2. Keep descriptions short and action-oriented.
3. Update the top-level README command/tool list.
4. Update `docs/usage.md` if it changes user workflow.
5. Add or adjust tests in `scripts/` when behavior is important.

## Repo-map changes

When changing repo-map behavior, verify:

- tracked and untracked non-ignored files are included
- sensitive paths are excluded
- `.pi/` runtime state is excluded
- noisy home/cache directories are excluded
- staleness detects added, removed, and modified mapped files
- pinned `done`/`stale`/`superseded` records stay out of search, injection, generated summaries, and context
- delegated subagent prompts, pasted reviews, and generic inspection commands do not become active long-term memory

## Documentation changes

Keep the README focused on quick start and command inventory. Put durable explanations, workflows, and design notes in `docs/`.
