# Development

## Project layout

```text
extensions/hybrid-memory.ts                 # stable two-line Pi entrypoint
extensions/runtime/registration.ts          # hook wiring and thin registrar composition
extensions/runtime/register-commands.ts     # slash commands
extensions/runtime/register-tools.ts        # agent-callable tools
extensions/runtime/configuration.ts         # cached Pi settings, bounds, enable/disable controls
extensions/runtime/foundation.ts            # paths, private JSONL heads, mutation/storage primitives
extensions/runtime/retrieval.ts             # lexical scoring, selection filters, path display rules
extensions/runtime/repo-context.ts           # repo map, staleness, generated project context
extensions/runtime/sessions.ts               # bounded session discovery/import/mining
extensions/runtime/curation.ts               # deterministic health/doctor/prune logic
extensions/runtime/lifecycle.ts              # startup/bootstrap/current-session orchestration
extensions/runtime/presentation-retrieval.ts # TUI rendering and prompt-time selection/injection
extensions/runtime/command-args.ts           # bounded slash-command parsing
extensions/runtime/memory-purge.ts           # explicit atomic hard-delete path
extensions/runtime/audit.ts                  # model packet, validation, batched application
extensions/runtime/audit-ui.ts               # progress and per-action review overlays
extensions/core/                             # small security/domain/file primitives
scripts/behavior-test.mjs                    # black-box command/tool/hook contracts
scripts/docs-test.mjs                        # local links and public command/tool inventory
scripts/security-test.mjs                    # audit/path/lock/permission/atomicity contracts
scripts/quality-test.mjs                     # selection/trust-boundary/latency harness
scripts/fixture-test.mjs                     # repo-map sampling/privacy fixture
scripts/benchmark.mjs                        # 15k-record retrieval/context benchmark
scripts/smoke-load.mjs                       # isolated temporary-home/project Pi load
```

## Validation

Run the fast tests while editing:

```bash
npm test
npm run test:quality
npm run test:fixture
npm run test:security
npm run test:docs
npm run benchmark
```

`npm test` includes strict TypeScript checks with unused-import enforcement, registration/architecture contracts (including cycle and module-size checks), documentation links/inventory, security contracts, behavior tests, the black-box quality harness, repo-map fixtures, and the 15k-record benchmark. The benchmark checks relevance, noise exclusion, the context cap, and warm retrieval p95—not just throughput.

Run the full local validation before handing off larger changes:

```bash
npm run validate
```

`npm run validate` runs:

```bash
npm test && npm run smoke:load
```

(`npm test` already includes the fixture test.)

Development requires Node `>=22.19.0`. Use `npm ci` when validating the lockfile exactly. GitHub CI runs the full validation path, including the isolated Pi load, on Node 22.19 and the current Node 24 line, then checks `npm audit` and package contents.

`smoke:load` asks Pi to load this package and run `/hmemory-health` without a normal session. It uses a disposable home and project so validation cannot refresh real user or repo `.pi/hybrid-memory` state.

Run the release gate before publishing or tagging:

```bash
npm run release:check
```

This adds `npm audit --audit-level=high` and `npm pack --dry-run` to the full validation path.

## Development principles

- Keep the extension local-first and Pi-native.
- Prefer JSONL/Markdown files over opaque databases.
- Keep startup and per-turn work bounded.
- For repo maps, prefer bounded sampling over empty metadata when a source file is just too large for full reads.
- Treat memory as untrusted context, not instructions.
- Redact secrets before storing or injecting text.
- Avoid indexing generated `.pi/` project state in the repo map.
- Keep command and tool output concise enough for Pi notifications.
- Keep the stable entrypoint thin and place new behavior in the narrowest existing runtime/core module.
- Keep runtime modules under the checked 650-line ceiling; split at a real responsibility boundary before adding another catchall.
- Keep mutation-only synchronization off the prompt-time retrieval path.

## Editing records during development

Memory files are append-only. To change a record programmatically, append a newer version with the same `scope:id`. For user-facing maintenance, prefer existing commands/tools such as `/hmemory-forget`, `/hmemory-done`, `/hmemory-pin`, and `hybrid_memory_forget`.

If manual edits damage a JSONL line, the reader skips that line rather than failing the entire file.

## Adding commands or tools

When adding a command/tool:

1. Register commands in `extensions/runtime/register-commands.ts` or tools in `extensions/runtime/register-tools.ts`.
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
- oversized source files still expose high-signal imports, symbols, commands, tools, and hooks through bounded sampling
- delegated subagent prompts, pasted reviews, and generic inspection commands do not become active long-term memory
- current live-session auto-import does not churn command-recipe records, while explicit session imports still mine useful recipes

## Documentation changes

Keep the README focused on quick start and command inventory. Put durable explanations, workflows, and design notes in `docs/`.
