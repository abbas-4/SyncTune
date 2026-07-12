<!-- Replace OWNER with your GitHub username in the two badge URLs below -->
[![CI](https://github.com/OWNER/synctune/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/synctune/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

# SyncTune

Move your playlists between music streaming services — free, open source, and honest about how it works.

SyncTune connects your Spotify and YouTube Music accounts, reads a playlist from one, and rebuilds it on the other with intelligent track matching, live transfer progress, and a manual review step for uncertain matches. The provider layer is a plug-in adapter architecture, so additional services (Tidal is the most feasible next) are additive rather than structural.

> **Status: early development.** The project is being built in public, phase by phase — see [ROADMAP.md](ROADMAP.md) for the full plan and current position. Nothing here is production-hosted yet.

## Features

- **Secure sign-in** — Supabase Auth (Google OAuth + email magic link), separate from music-service connections
- **Connected accounts** — per-provider OAuth 2.0 + PKCE flows; access/refresh tokens AES-256-GCM encrypted at rest
- **Playlist browsing** — paginated playlists and tracks from every connected service
- **Intelligent matching** — ISRC where available, plus normalized title/artist similarity and duration scoring, with confidence thresholds (auto-add ≥ 0.85, manual review 0.50–0.85)
- **Resumable transfers** — transfers run as small batch steps with a persisted cursor; they survive tab closes, redeploys, and API quota exhaustion
- **Live progress** — per-track status streamed to the UI over Supabase Realtime
- **Transfer history** — every past transfer with per-track outcomes

## How it works

Two design constraints shape the whole architecture, and SyncTune treats them as facts rather than pretending they don't exist:

1. **There are no background workers on free hosting.** Vercel's Hobby tier runs short-lived serverless functions only. So the transfer engine is a *batch step processor*: each invocation matches and inserts a handful of tracks, persists its cursor to Postgres, and exits. The client keeps invoking the step endpoint until the job reaches a terminal state, and progress streams to the UI via Supabase Realtime. All state lives in the database, which is what makes transfers resumable for free.

2. **YouTube's API quota is brutally small for search.** The YouTube Data API v3 grants 10,000 units/day by default; a single `search.list` costs 100 units and a `playlistItems.insert` costs 50. A naive 100-track transfer costs ~15,000 units — more than a full day's budget. SyncTune budgets quota explicitly, shares a cross-user match cache of public track metadata, and treats `paused_quota` as a first-class transfer state with a resume button, not an error.

Also worth knowing: new Spotify apps run in **development mode** (up to 25 manually allowlisted users), and extended quota is effectively unavailable to hobby projects under Spotify's current policy. SyncTune works fully for the developer and invited users, and is documented accordingly.

## Tech stack

Next.js 15 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS v4 · shadcn/ui · Supabase (Auth, Postgres + RLS, Realtime) · Zod · Vitest · Vercel

Everything in the stack is free.

## Getting started

### Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project (free tier)
- A [Spotify developer app](https://developer.spotify.com/dashboard) — add yourself under *User Management* while in development mode
- A [Google Cloud project](https://console.cloud.google.com) with the **YouTube Data API v3** enabled and an OAuth consent screen in testing mode

### Setup

```bash
git clone https://github.com/OWNER/synctune.git
cd synctune
npm install

cp .env.example .env.local
# fill in every value — .env.example documents where each one comes from

npx supabase link --project-ref <your-project-ref>
npx supabase db push        # applies migrations (from Phase 2 of the roadmap onward)

npm run dev
```

Register these redirect URIs in the respective developer dashboards (swap in your production URL when deploying):

```
http://localhost:3000/api/connect/spotify/callback
http://localhost:3000/api/connect/youtube/callback
```

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server (Turbopack) |
| `npm run build` | Production build (includes type-checking) |
| `npm run lint` | ESLint |
| `npm test` / `npm run test:watch` | Vitest suite (matching engine) |
| `npm run db:types` | Regenerate `src/types/database.ts` from the linked Supabase project |

## Project structure

```
synctune/
├── supabase/migrations/     # SQL migrations, RLS policies
└── src/
    ├── app/                 # routes: marketing, auth, (app) shell, /api handlers
    ├── components/          # ui (shadcn), layout, connections, playlists, transfers
    ├── lib/
    │   ├── providers/       # MusicProvider adapters (spotify, youtube, registry)
    │   ├── matching/        # pure matching engine + tests
    │   ├── transfers/       # batch step engine
    │   ├── supabase/        # client/server/admin factories
    │   ├── crypto.ts        # AES-256-GCM token encryption
    │   └── quota.ts         # YouTube unit budgeting
    ├── hooks/
    └── types/
```

The full annotated tree and the phase-by-phase build order live in [ROADMAP.md](ROADMAP.md).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, branch naming, and the Conventional Commits convention this repo uses. Want another streaming service supported? Open a [provider request](.github/ISSUE_TEMPLATE/provider_request.yml).

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Never open a public issue for a security problem.

## License

[MIT](LICENSE)
