# Contributing

Thanks for taking a look at `pi-hybrid-memory`. The project is intentionally small, local-first, and security-conscious because it sits in the context path for coding agents.

## Good first areas

- documentation examples for real maintainer workflows
- prompt-injection and redaction regression fixtures
- focused repo-map parser improvements
- small UX improvements for `/hmemory-health`, `/hmemory-review`, `/hmemory-dashboard`, and `/hmemory-audit`
- tests that prove stale, done, superseded, or purged records stay out of injection

## Development setup

Install dependencies used by Pi in your normal Pi environment, then load this checkout as a local Pi package:

```json
{
  "packages": [
    "<path-to-your-local-clone>/pi-hybrid-memory"
  ]
}
```

Run `/reload` inside Pi after changing the package list.

## Validation

Run the fast test suite before opening a change:

```bash
npm test
```

Run the full local validation for larger changes:

```bash
npm run validate
```

`npm run validate` runs the source/behavior/fixture tests and a Pi smoke-load check for `/hmemory-health`.

## Security and privacy checklist

For changes that touch memory storage, retrieval, session import, repo maps, redaction, injection, audit, or purge behavior, check that:

- secrets are redacted before storage, injection, generated summaries, and tool/command output
- retrieved memory remains labeled as untrusted context
- inactive records stay out of default search, injection, summaries, and generated context
- sensitive paths and `.pi/` runtime state are excluded from repo maps
- model-assisted cleanup validates structured actions before applying append-only changes
- `/hmemory-purge` does not copy purged content into audit markers

See [docs/security-and-privacy.md](docs/security-and-privacy.md) and [SECURITY.md](SECURITY.md) for the threat model.

## Documentation

Keep the top-level README focused on quick orientation, security posture, install, and command inventory. Put longer explanations and workflows under `docs/`.
