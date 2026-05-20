# Configuration

## Install as an OMP extension

Add a checkout to OMP's global config:

```yaml
# ~/.omp/agent/config.yml
extensions:
  - <path-to-your-local-clone>/omp-hybrid-memory
```

Then run:

```text
/reload
```

or restart OMP. For one-off validation without changing config:

```bash
omp --no-session --no-extensions -e <path-to-your-local-clone>/omp-hybrid-memory -p '/hmemory-health'
```

The package advertises its extension in `package.json`:

```json
{
  "omp": {
    "extensions": ["./extensions/hybrid-memory.ts"]
  }
}
```

## Storage paths

User memory:

```text
~/.omp/agent/memory/
  records.jsonl
  summary.md
  state.json
```

Project memory:

```text
<project>/.omp/hybrid-memory/
  records.jsonl
  summary.md
  active.json   # generated active-work index
  context.md
  repomap.json
  audits/       # model audit reports
  state.json
```

Run `/hmemory-files` to show the exact paths for the current session.

## Git ignore recommendation

Project memory is runtime state. Add `.omp/` to the project `.gitignore` unless you intentionally want to version generated memory files.

```gitignore
.omp/
```

## Startup behavior

On session start the extension initializes missing files and performs a bounded refresh:

- Rebuilds a missing/stale repo map only when the project is small enough for the cheap path.
- Imports the current session plus a couple recent project sessions.
- Prunes duplicate/old project session recaps.
- Updates OMP status chrome with active/project counts and repo freshness.

For larger or older projects, use an explicit command:

```text
/hmemory-refresh 5
/hmemory-bootstrap 250
```

## Manual maintenance commands

```text
/hmemory-health
/hmemory-config
/hmemory-prune [maxActiveRecaps]
/hmemory-review
/hmemory-audit [preview|apply] [focus]
/hmemory-forget <id|query> [stale|done|superseded]
```

## Tuning knobs

The defaults are intentionally compact. For global OMP config, add a `hybridMemory` object to `~/.omp/agent/config.yml`:

```yaml
hybridMemory:
  maxInjectChars: 4200
  injectSectionLimits:
    User Preferences: 5
    Project Decisions: 5
    Active Work: 5
    Recipes: 3
    Relevant Session Recaps: 2
    Relevant Codebase Notes: 4
  repoMapFileLimit: 1500
  repoMapReadMaxBytes: 200000
  repoMapWalkFallbackLimit: 2000
  startupRepoMapFileLimit: 500
  pruneActiveSessionRecaps: 12
  autoPruneActiveSessionRecaps: 8
  bootstrapPruneActiveSessionRecaps: 12
  staleCodebaseNotesOnFileChange: true
```

For project-local overrides, use `.omp/settings.json` with the same `hybridMemory` object. Project settings override global settings.

You can also group repo-map and prune values if you prefer a tidier settings file:

```json
{
  "hybridMemory": {
    "repoMap": {
      "fileLimit": 2500,
      "readMaxBytes": 200000,
      "walkFallbackLimit": 3000,
      "startupFileLimit": 700
    },
    "prune": {
      "activeSessionRecaps": 16,
      "autoActiveSessionRecaps": 10,
      "bootstrapActiveSessionRecaps": 16
    },
    "compaction": {
      "staleCodebaseNotesOnFileChange": true
    }
  }
}
```

Run `/hmemory-config` to inspect the effective values for the current project.
