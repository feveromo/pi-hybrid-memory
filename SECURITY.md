# Security Policy

`pi-hybrid-memory` handles local agent memory, session-derived context, and repo metadata. Security reports are welcome, especially when they involve memory poisoning, prompt-injection boundaries, secret redaction, path handling, or unintended disclosure of local project data.

## Supported versions

This project is pre-1.0. Security fixes target the latest `main` branch and the most recent tagged release when one exists.

## In scope

- retrieved memory being treated as instructions instead of untrusted context
- secret or credential patterns that are stored, injected, or shown without redaction
- sensitive local paths being indexed into repo maps or generated context
- unsafe path handling in commands, tools, session import, repo-map generation, audit reports, or purge flows
- `/hmemory-purge` failing to remove all JSONL versions of a selected record
- model-audit behavior that applies unvalidated or unexpectedly broad changes
- cross-process races that lose, duplicate, or partially write memory mutations
- unsafe symlink traversal into memory, session, or repo-map paths

## Out of scope

- stale or low-quality memory that can be corrected with normal review, stale, done, superseded, or purge flows
- expected local storage under `~/.pi/agent/memory/` or `<project>/.pi/hybrid-memory/`
- reports that require access to private user memory files without the user's consent
- broad dependency reports without a demonstrated impact on this package

## Reporting

If GitHub private vulnerability reporting is available for this repository, please use it.

If private reporting is not available, open a minimal public issue that says you have a security report and which area it affects, but do not include secrets, exploit details, private file paths, or raw session data in the public issue.

## Hardening principles

- Memory is private user data.
- Memory directories and files default to owner-only permissions, and generated state is replaced atomically.
- Retrieved memory is context, not authority.
- Redaction is best effort and should be tested continuously.
- Cleanup should be auditable; hard deletion should be explicit.
- Mutations must be serialized across concurrent tools and independent Pi processes.
- Model-assisted cleanup must remain bounded, redacted, validated, and user-directed.
