# Contributing to SyncTune

Thanks for your interest. This document covers everything you need to go from clone to merged PR.

## Development setup

Follow the [Getting started](README.md#getting-started) section of the README — prerequisites, `.env.local`, Supabase linking, and `npm run dev`. The [ROADMAP.md](ROADMAP.md) explains the architecture and the current build phase; read the relevant section before touching a subsystem.

## Branches

Branch from `main`, named by intent:

```
feat/tidal-adapter
fix/spotify-token-refresh
docs/readme-quota-section
```

## Commit messages — Conventional Commits

This repo uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Format:

```
<type>(<optional scope>): <imperative, lower-case summary>
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `ci`, `chore`, `perf`, `style`

**Scopes used here:** `providers`, `matching`, `transfers`, `auth`, `db`, `ui`, `quota`

Examples:

```
feat(providers): add tidal adapter
fix(matching): treat remaster suffixes as equivalent titles
test(matching): cover feat.-credit normalization
ci: cache npm dependencies in workflow
docs: document paused_quota resume behavior
```

Keep commits atomic — one logical change each. A reviewer should be able to read the history like a changelog.

## Code standards

- **TypeScript strict, no `any`** in app code; `noUncheckedIndexedAccess` is on, handle the `undefined`.
- **Server Components by default**; add `"use client"` only where interactivity requires it.
- **Validate at the boundary** — every route handler parses its input with Zod before touching logic.
- **Secrets stay server-side** — provider tokens are decrypted only inside route handlers; nothing sensitive in `NEXT_PUBLIC_*`.
- **Providers implement the `MusicProvider` interface** in `src/lib/providers/types.ts`. A new service should not require edits outside `src/lib/providers/` plus OAuth env config.
- **The matching engine stays pure** — no I/O in `src/lib/matching/`; it must remain unit-testable without network access.

## Tests

Matching-engine changes require Vitest coverage in `src/lib/matching/__tests__/`. Run the local quality gate before pushing:

```bash
npm run lint && npm test && npm run build
```

CI runs the same three steps on every PR.

## Pull requests

1. One concern per PR; link the issue it closes (`Closes #12`).
2. Fill in the PR template, including how you tested.
3. CI must be green before review.
4. Squash-merge is fine — the PR title should itself be a valid conventional commit, since it becomes the merge commit.

## Requesting a new music service

Open a [provider request issue](.github/ISSUE_TEMPLATE/provider_request.yml) first. Whether a service can be supported is almost always an *API access* question (open developer program, quota, OAuth support), not a code question — the issue template walks through what to check.
