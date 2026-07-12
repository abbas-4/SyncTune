# Security Policy

## Supported versions

Only the latest code on `main` is supported. There are no maintained release branches yet.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities through **GitHub's private vulnerability reporting**: the repository's *Security* tab → *Report a vulnerability*. You'll get an acknowledgment within 72 hours and a status update as the report is triaged and fixed.

If private reporting is unavailable for any reason, contact the maintainer via the contact information on the repository owner's GitHub profile.

## Areas of particular interest

Given what SyncTune handles, reports in these areas are especially valuable:

- Provider token handling — AES-256-GCM encryption at rest (`src/lib/crypto.ts`), decryption paths, anything that could leak an access or refresh token to the client or logs
- OAuth flows — `state`/PKCE validation in the `/api/connect/*` route handlers
- Row Level Security — any query path that returns another user's playlists, connections, or transfers
- The Supabase service-role client — any route where it's reachable without an authenticated, authorized user

## Out of scope

- Rate limits or quota exhaustion of the upstream music APIs (documented behavior, see README)
- Vulnerabilities requiring a compromised developer machine or leaked `.env` values
