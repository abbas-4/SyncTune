# SyncTune — Development Roadmap

A free, production-quality playlist transfer app. Users sign in, connect their music accounts, pick a playlist, and SyncTune rebuilds it on another service with intelligent track matching, live progress, and a review step for uncertain matches.

Launch providers: **Spotify** and **YouTube Music**. The architecture treats providers as plug-in adapters so future services are additive, not structural.

---

## 1. Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 15 (App Router) + React 19 | RSC-first, route handlers for all APIs |
| Language | TypeScript (strict) | No `any` in app code |
| Styling | Tailwind CSS v4 + shadcn/ui | Theme tokens in `globals.css`; SyncTune brand (blue→purple gradient) reused from the existing brand guidelines |
| Backend | Supabase | Auth, Postgres with RLS, Realtime for progress updates |
| Hosting | Vercel Hobby | Serverless route handlers only — no long-running workers |
| Validation | Zod | Every API input parsed at the boundary |
| Testing | Vitest | Unit tests for the matching engine (pure functions) |

Everything above is free. Zod and Vitest are the only additions beyond the stack you specified — both zero-cost, both standard.

## 2. Platform constraints that shape the design

These are facts about the provider APIs, not implementation choices. The architecture is built around them rather than pretending they don't exist.

**Spotify — development mode cap.** New Spotify apps run in development mode: up to 25 manually allowlisted users. Extended quota is effectively unavailable to hobby projects since Spotify's 2025 policy change. SyncTune therefore works perfectly for you and invited users, and the README documents this honestly — appropriate for a portfolio product.

**YouTube — quota economics.** There is no official YouTube Music API; the standard approach is the YouTube Data API v3. Default quota is 10,000 units/day. A `search.list` call costs **100 units**, a `playlistItems.insert` costs **50**. A naive 100-track transfer costs ~15,000 units — more than a full day's quota. Consequences baked into the design: a quota budget tracker, a shared search-result cache, transfers that are *resumable by design* (a `paused_quota` state is first-class, not an error), and batch sizes tuned to the budget.

**Vercel Hobby — no background workers.** Serverless functions have short, capped execution windows. A transfer can't run inside one invocation. Instead, the transfer engine is a **batch step processor**: each invocation processes a small batch of tracks, persists a cursor, and exits. The client keeps invoking the step endpoint until the job reaches a terminal state, and progress streams to the UI via Supabase Realtime. State lives entirely in Postgres, so a transfer survives page reloads, quota pauses, and redeploys.

**Future providers — access, not code, is the blocker.** Tidal has an open developer platform (most feasible next). Deezer's developer registration is closed. Apple Music requires a paid Apple Developer Program membership ($99/yr — conflicts with the free-only constraint). Amazon Music's API is invite-only. The adapter pattern means each becomes roughly one file plus OAuth config whenever access opens up.

## 3. Architecture decisions

**D1 — Sign-in and music connections are separate systems.** Supabase Auth handles *identity* (Google OAuth + email magic link). Connecting Spotify/YouTube for *API access* uses custom OAuth 2.0 authorization-code + PKCE flows in our own route handlers, with tokens stored per-provider in `connected_accounts`. Conflating the two (e.g. using Supabase's provider tokens) breaks down the moment a user needs multiple linked services, which is the entire product.

**D2 — Tokens are encrypted at the application layer.** Access/refresh tokens are AES-256-GCM encrypted with a server-side key before hitting Postgres, decrypted only inside route handlers using the Supabase service-role client. RLS is defense in depth on top, not the only line.

**D3 — Client-driven batch processing + Realtime progress.** Described above. This is the honest free-tier answer to "background jobs" and it degrades gracefully: if the user closes the tab mid-transfer, the job pauses at its cursor and a "Resume" button picks it up.

**D4 — Matching is a pure, provider-agnostic module.** Normalization → candidate search → weighted scoring (ISRC when both sides expose it, token-set title/artist similarity, duration delta). Confidence thresholds: ≥ 0.85 auto-add, 0.50–0.85 flagged for manual review, < 0.50 marked failed. Pure TypeScript, no I/O, fully unit-testable against nasty real-world cases (feat. credits, remasters, live versions, karaoke covers).

**D5 — Shared match cache.** Successful matches are cached by `(dest_provider, normalized track key)` and shared across users — it's public track metadata, and it directly stretches the YouTube quota.

## 4. Database schema

```sql
-- 0001: profiles (auto-created via auth trigger)
profiles (
  id uuid PK → auth.users,
  display_name text,
  created_at timestamptz
)

-- 0002: connected music accounts
connected_accounts (
  id uuid PK,
  user_id uuid → auth.users,
  provider text CHECK IN ('spotify','youtube'),
  provider_user_id text,
  display_name text,
  access_token_enc text,      -- AES-256-GCM
  refresh_token_enc text,
  expires_at timestamptz,
  scopes text[],
  UNIQUE (user_id, provider)
)

-- 0003: transfers + per-track items
transfers (
  id uuid PK,
  user_id uuid → auth.users,
  source_provider text, dest_provider text,
  source_playlist_id text, source_playlist_name text,
  dest_playlist_id text,
  status text,                -- pending | running | needs_review |
                              -- paused_quota | completed | failed | cancelled
  total_tracks int, matched int, needs_review int, failed int,
  cursor int,                 -- resumability
  error text,
  created_at / updated_at timestamptz
)

transfer_items (
  id uuid PK,
  transfer_id uuid → transfers,
  position int,
  source_track jsonb,         -- {title, artists[], album, duration_ms, isrc?}
  match_candidates jsonb,     -- top-N scored candidates for review UI
  matched_track jsonb,
  confidence numeric,
  status text                 -- pending | matched | needs_review | skipped | failed | added
)

-- 0004: cross-user search cache (quota saver)
match_cache (
  dest_provider text,
  normalized_key text,        -- hash of normalized title+artists
  result jsonb,
  UNIQUE (dest_provider, normalized_key)
)
```

RLS: every user table scoped to `auth.uid()`. `match_cache` is readable by authenticated users, writable only via service role.

## 5. Folder structure

```
synctune/
├── README.md
├── ROADMAP.md                      # this file
├── .env.example
├── package.json
├── tsconfig.json
├── next.config.ts
├── postcss.config.mjs
├── components.json                 # shadcn/ui config
├── vitest.config.ts
├── supabase/
│   └── migrations/
│       ├── 0001_profiles.sql
│       ├── 0002_connected_accounts.sql
│       ├── 0003_transfers.sql
│       └── 0004_match_cache.sql
└── src/
    ├── middleware.ts               # session refresh + protected routes
    ├── app/
    │   ├── globals.css             # Tailwind v4 theme + SyncTune brand tokens
    │   ├── layout.tsx
    │   ├── page.tsx                # landing
    │   ├── login/page.tsx
    │   ├── auth/callback/route.ts  # Supabase code exchange
    │   ├── (app)/                  # authenticated shell
    │   │   ├── layout.tsx          # sidebar + topbar
    │   │   ├── dashboard/page.tsx
    │   │   ├── connections/page.tsx
    │   │   ├── playlists/
    │   │   │   ├── page.tsx
    │   │   │   └── [provider]/[playlistId]/page.tsx
    │   │   ├── transfers/
    │   │   │   ├── new/page.tsx    # source → destination wizard
    │   │   │   └── [id]/page.tsx   # live progress + review
    │   │   └── history/page.tsx
    │   └── api/
    │       ├── connect/[provider]/start/route.ts
    │       ├── connect/[provider]/callback/route.ts
    │       ├── connect/[provider]/route.ts          # DELETE = disconnect
    │       ├── playlists/route.ts
    │       ├── playlists/[provider]/[id]/tracks/route.ts
    │       └── transfers/
    │           ├── route.ts                          # POST create, GET list
    │           └── [id]/
    │               ├── route.ts                      # GET status, PATCH cancel
    │               ├── process/route.ts              # batch step worker
    │               └── review/route.ts               # resolve flagged matches
    ├── components/
    │   ├── ui/                     # shadcn primitives
    │   ├── layout/                 # sidebar, topbar, user-menu
    │   ├── connections/            # provider-card, connect-button
    │   ├── playlists/              # playlist-grid, playlist-card, track-list
    │   └── transfers/              # wizard, progress-panel, review-table, history-table
    ├── lib/
    │   ├── supabase/               # client.ts, server.ts, admin.ts
    │   ├── providers/
    │   │   ├── types.ts            # MusicProvider interface + shared types
    │   │   ├── registry.ts
    │   │   ├── spotify.ts
    │   │   └── youtube.ts
    │   ├── matching/
    │   │   ├── normalize.ts
    │   │   ├── similarity.ts
    │   │   ├── score.ts
    │   │   ├── index.ts
    │   │   └── __tests__/matching.test.ts
    │   ├── transfers/engine.ts     # one batch step: fetch → match → insert → advance cursor
    │   ├── crypto.ts               # AES-256-GCM helpers
    │   ├── quota.ts                # YouTube unit budgeting
    │   └── utils.ts
    ├── hooks/
    │   ├── use-transfer-progress.ts  # Realtime subscription
    │   └── use-connections.ts
    └── types/
        ├── index.ts
        └── database.ts             # generated Supabase types
```

~55 files. The provider adapter interface every service implements:

```ts
interface MusicProvider {
  id: ProviderId;
  getAuthUrl(state: string, codeChallenge: string): string;
  exchangeCode(code: string, verifier: string): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
  getProfile(tokens: TokenSet): Promise<ProviderProfile>;
  listPlaylists(tokens: TokenSet, cursor?: string): Promise<Page<Playlist>>;
  listTracks(tokens: TokenSet, playlistId: string, cursor?: string): Promise<Page<Track>>;
  search(tokens: TokenSet, query: TrackQuery): Promise<Track[]>;
  createPlaylist(tokens: TokenSet, name: string, description?: string): Promise<Playlist>;
  addTracks(tokens: TokenSet, playlistId: string, trackIds: string[]): Promise<void>;
}
```

## 6. Build phases

One file per step, in this order. Each phase ends with a "done when" check before moving on.

### Phase 0 — Scaffold & theme (8 files)
1. `package.json` · 2. `tsconfig.json` · 3. `next.config.ts` · 4. `postcss.config.mjs` · 5. `components.json` · 6. `src/app/globals.css` (brand tokens, dark-first) · 7. `src/app/layout.tsx` · 8. `.env.example`

**Done when:** `npm run dev` renders a themed shell; fonts, colors, and radius tokens match the SyncTune brand.

### Phase 1 — Identity (7 files)
`lib/supabase/client.ts` → `server.ts` → `admin.ts` → `src/middleware.ts` → `login/page.tsx` → `auth/callback/route.ts` → `(app)/layout.tsx` + `dashboard/page.tsx` stub

**Done when:** Google + magic-link sign-in works; unauthenticated visits to `(app)` routes redirect to login; session survives refresh.

### Phase 2 — Schema & crypto (6 files)
Migrations 0001–0004 → `lib/crypto.ts` → `types/database.ts` (generated)

**Done when:** migrations apply cleanly; RLS verified with two test users; encrypt/decrypt round-trips.

### Phase 3 — Provider layer & connections (9 files)
`providers/types.ts` → `registry.ts` → `spotify.ts` → `youtube.ts` → `lib/quota.ts` → connect `start`/`callback`/`DELETE` routes → `connections/page.tsx` + components

**Done when:** both accounts connect and disconnect; tokens land encrypted; expired Spotify tokens auto-refresh; YouTube quota counter ticks.

### Phase 4 — Playlist browsing (6 files)
Playlist API routes → `playlists/page.tsx` → detail page → grid/card/track-list components

**Done when:** playlists and tracks from both services browse with pagination, artwork, durations, loading skeletons.

### Phase 5 — Matching engine (5 files)
`normalize.ts` → `similarity.ts` → `score.ts` → `index.ts` → tests

**Done when:** Vitest suite passes on the hard cases — "(feat. X)", "— 2011 Remaster", live versions, punctuation/diacritics, near-duplicate durations.

### Phase 6 — Transfer engine (8 files)
`transfers/engine.ts` → `POST/GET /api/transfers` → `[id]` status route → `process` route → `transfers/new` wizard → `use-transfer-progress.ts` → `[id]/page.tsx` progress view → progress-panel component

**Done when:** a real Spotify→YouTube transfer of a small playlist completes end-to-end with a live progress bar; killing the tab mid-run and reopening resumes from the cursor; exhausted quota lands in `paused_quota`, not `failed`.

### Phase 7 — Review & history (4 files)
`review` route → review-table component → history page + table

**Done when:** flagged tracks show top candidates side-by-side; picking one adds it to the destination playlist; history lists every past transfer with per-track outcomes.

### Phase 8 — Polish (4–6 files touched)
Landing page content, empty/error states everywhere, 429 backoff hardening, accessibility pass (focus order, `aria-live` on progress, contrast against the gradient, reduced-motion), responsive audit.

### Phase 9 — Ship (2 files + config)
`README.md`, final `.env.example`, Vercel + Supabase production config, OAuth redirect URIs, smoke test.

## 7. Security checklist

App-layer AES-256-GCM on all provider tokens; service-role key server-only, never in `NEXT_PUBLIC_*`; RLS on every table; OAuth `state` + PKCE on every connection flow; minimal scopes (`playlist-read-private`, `playlist-modify-private/public`; `youtube` scope only); Zod-parsed inputs on every route handler; no tokens or PII in logs; ownership checks on every transfer mutation (RLS + explicit `user_id` filter).

## 8. Accessibility & performance

Server Components by default, client components only where interactivity demands it; paginated provider fetches, never full-playlist loads in one request; `next/image` for artwork; keyboard-complete navigation with visible focus rings; `aria-live="polite"` progress announcements; skeletons over spinners; `prefers-reduced-motion` respected; Lighthouse a11y ≥ 95 as the Phase 8 gate.
