# Deploying SyncTune (Vercel + Render)

This guide deploys the **frontend to Vercel** and the **backend to Render**, both on free plans. Nothing here changes how SyncTune runs locally: with no production variables set, it behaves exactly as described in the [README](README.md).

Placeholders used below. Replace them with your own values once you know them:

| Placeholder | Example shape | Where it comes from |
| --- | --- | --- |
| `<frontend>` | `your-project.vercel.app` | Your Vercel project's production domain |
| `<backend>` | `your-service.onrender.com` | Your Render web service's URL |

## Contents

- [Choose a setup](#choose-a-setup)
- [1. Deploy the frontend to Vercel](#1-deploy-the-frontend-to-vercel)
- [2. Deploy the backend to Render](#2-deploy-the-backend-to-render)
- [3. Connect them (setup A: Vercel rewrites)](#3-connect-them-setup-a-vercel-rewrites)
- [4. Update Google Cloud](#4-update-google-cloud)
- [5. Update the Spotify dashboard](#5-update-the-spotify-dashboard)
- [6. Check the deployment](#6-check-the-deployment)
- [Environment variable reference](#environment-variable-reference)
- [Limitations of the free setup](#limitations-of-the-free-setup)

## Choose a setup

SyncTune keeps you signed in with a session cookie set by the backend. Vercel (`*.vercel.app`) and Render (`*.onrender.com`) are different sites, which affects how browsers treat that cookie.

| | **A. Vercel rewrites (recommended)** | **B. Direct calls** |
| --- | --- | --- |
| How it works | The browser only talks to `<frontend>`. Vercel forwards `/api`, `/auth` and `/oauth2` to Render. | The browser loads the app from `<frontend>` and calls `<backend>` directly. |
| Session cookie | First-party, `Secure; SameSite=Lax` | Third-party, `Secure; SameSite=None` |
| Browsers | All | **Chrome and Edge only.** Safari blocks third-party cookies and Firefox partitions them by default, so sign-in won't stick there. |
| Extra file | Add your Render URL to `vercel.json` | None (keep the repo's `vercel.json` as is) |

The backend chooses the cookie mode automatically. If `FRONTEND_URL` and `GOOGLE_REDIRECT_URI` share an origin, it uses setup A; otherwise setup B.

## 1. Deploy the frontend to Vercel

Create a Vercel project from the GitHub repository with these settings:

| Setting | Value |
| --- | --- |
| Framework preset | Vite |
| Root directory | `./` (repository root) |
| Install command | `npm install` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node.js version | 22.x or newer (Vite needs ≥ 22.12 on the 22 line) |

Environment variable (Project Settings → Environment Variables):

| Name | Setup A | Setup B |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `https://<frontend>` | `https://<backend>` |

`VITE_API_BASE_URL` is a public URL, not a secret. Vite bakes it into the JavaScript at **build time**, so redeploy after changing it. Never create any other `VITE_` variable that contains a secret, because every `VITE_` value is visible in the browser.

Deploy once to learn your `<frontend>` domain. The app will report the backend as unreachable until steps 2 and 3 are done.

## 2. Deploy the backend to Render

Create a **Web Service** from the same repository:

| Setting | Value |
| --- | --- |
| Runtime / Language | Node |
| Root directory | `server` |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Instance type | Free |

`server/package.json` declares `"engines": { "node": ">=22" }`, which the backend's Google client library requires.

Environment variables (Render → Environment):

| Name | Setup A | Setup B |
| --- | --- | --- |
| `NODE_ENV` | `production` | `production` |
| `FRONTEND_URL` | `https://<frontend>` | `https://<frontend>` |
| `GOOGLE_REDIRECT_URI` | `https://<frontend>/oauth2/callback` | `https://<backend>/oauth2/callback` |
| `GOOGLE_CLIENT_ID` | *(from Google Cloud)* | *(same)* |
| `GOOGLE_CLIENT_SECRET` | *(from Google Cloud)* | *(same)* |
| `SESSION_SECRET` | *(new long random string)* | *(same)* |
| `SPOTIFY_CLIENT_ID` | *(optional, from Spotify)* | *(same)* |
| `SPOTIFY_CLIENT_SECRET` | *(optional, from Spotify)* | *(same)* |
| `SPOTIFY_REDIRECT_URI` | `https://<frontend>/auth/spotify/callback` | `https://<backend>/auth/spotify/callback` |

Notes:

- **Don't set `PORT`.** Render provides it.
- **Use a new `SESSION_SECRET`** for production, not your local one. Generate it with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- **Enter secrets only in Render's dashboard.** Never commit them. `.env` files are ignored by git.
- **Startup checks:** with `NODE_ENV=production`, the server refuses to start unless `FRONTEND_URL` and `GOOGLE_REDIRECT_URI` are `https://` URLs. Spotify stays off (with a log message) unless `SPOTIFY_REDIRECT_URI` is set too.
- **`TRUST_PROXY` (optional):** defaults to `1`, meaning one trusted proxy in front of the app. That lets Express see the original HTTPS scheme so it can set the secure cookie. If the logs show *"A request did not arrive over HTTPS"*, adjust it.

On startup the log prints the public settings it is using (mode, frontend URL, Google redirect URI and cookie mode), never secrets.

## 3. Connect them (setup A: Vercel rewrites)

Skip this step for setup B.

Replace the contents of `vercel.json` in the repository root with this, replacing `<backend>` with your Render hostname:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://<backend>/api/:path*" },
    { "source": "/auth/:path*", "destination": "https://<backend>/auth/:path*" },
    { "source": "/oauth2/:path*", "destination": "https://<backend>/oauth2/:path*" },
    { "source": "/((?!api/|auth/|oauth2/).*)", "destination": "/index.html" }
  ],
  "headers": [
    { "source": "/api/:path*", "headers": [{ "key": "x-vercel-enable-rewrite-caching", "value": "0" }] },
    { "source": "/auth/:path*", "headers": [{ "key": "x-vercel-enable-rewrite-caching", "value": "0" }] },
    { "source": "/oauth2/:path*", "headers": [{ "key": "x-vercel-enable-rewrite-caching", "value": "0" }] }
  ]
}
```

The last rewrite serves the dashboard for its own pages (`/history`, `/match-cache`, `/settings`), so opening or refreshing one of those links works. It skips `/api`, `/auth` and `/oauth2`, which always go to Render; keep it last anyway. The `x-vercel-enable-rewrite-caching: 0` headers stop Vercel from caching proxied responses, which are per-user. The backend also sends `Cache-Control: no-store` on every response. Commit the file and let Vercel redeploy.

## 4. Update Google Cloud

In Google Cloud Console → your OAuth client (**Web application**), add an **authorized redirect URI**. Keep the localhost one for local development.

- Setup A: `https://<frontend>/oauth2/callback`
- Setup B: `https://<backend>/oauth2/callback`

It must match `GOOGLE_REDIRECT_URI` exactly. If Google asks for **authorized domains** on the consent screen, add the host from that URI.

While the OAuth consent screen is in **Testing**, only the Google accounts listed as **test users** can sign in. Opening sign-in to everyone means publishing the app, and Google may require verification for the YouTube scope.

## 5. Update the Spotify dashboard

In the Spotify Developer Dashboard → your app → Settings, add a **redirect URI**. Keep `http://127.0.0.1:3001/auth/spotify/callback` for local development.

- Setup A: `https://<frontend>/auth/spotify/callback`
- Setup B: `https://<backend>/auth/spotify/callback`

It must match `SPOTIFY_REDIRECT_URI` exactly. In Development Mode, only accounts added under **User Management** can sign in (a small number of users), and the app owner needs Spotify Premium.

## 6. Check the deployment

1. Open `https://<backend>/api/health`. It should return `{"status":"ok",…}`. A free instance can take about a minute to wake up.
2. Open `https://<frontend>`. The sidebar should show YouTube and Spotify as **Not connected**, not "Offline".
3. Connect YouTube, then Spotify. Each should return you to the dashboard as **Connected**.
4. In the browser's developer tools (Application → Cookies), confirm the `synctune.sid` cookie:
   - Setup A: on `<frontend>`, marked Secure, SameSite Lax.
   - Setup B: on `<backend>`, marked Secure, SameSite None.
5. Load a playlist and click **Find YouTube matches**. Only create a playlist when you mean to.

If sign-in "works" but the dashboard still says Not connected, the cookie isn't reaching the backend. Check that `FRONTEND_URL` and `VITE_API_BASE_URL` exactly match the address in your browser bar (https, no trailing path), and that you're using setup A for Safari and Firefox.

## Environment variable reference

**Backend (Render, or `server/.env` locally)**

| Variable | Required | Local default | Production |
| --- | --- | --- | --- |
| `NODE_ENV` | Production only | *(unset)* | `production` |
| `GOOGLE_CLIENT_ID` | Yes | — | From Google Cloud |
| `GOOGLE_CLIENT_SECRET` | Yes | — | From Google Cloud |
| `SESSION_SECRET` | Yes | — | Long random string |
| `FRONTEND_URL` | Production | `http://localhost:5173` | `https://<frontend>` |
| `GOOGLE_REDIRECT_URI` | Production | `http://localhost:<PORT>/oauth2/callback` | See step 2 |
| `SPOTIFY_CLIENT_ID` | For Spotify | — | From Spotify |
| `SPOTIFY_CLIENT_SECRET` | For Spotify | — | From Spotify |
| `SPOTIFY_REDIRECT_URI` | Production, for Spotify | `http://127.0.0.1:<PORT>/auth/spotify/callback` | See step 2 |
| `PORT` | No | `3001` | Set by Render |
| `TRUST_PROXY` | No | *(not used)* | `1` |

**Frontend (Vercel, or `.env.local` locally)**

| Variable | Required | Local default | Production |
| --- | --- | --- | --- |
| `VITE_API_BASE_URL` | Production | `http://localhost:3001` | See step 1 |

## Limitations of the free setup

- **Sessions live in server memory.** A free Render instance spins down after about 15 minutes without traffic, and every restart or redeploy signs everyone out and forgets in-progress transfers and cached matches. Express also warns at startup that its memory session store isn't meant for production. A persistent session store would fix this, but isn't set up.
- **Cold starts:** the first request after a spin-down takes about a minute.
- **Run a single instance only.** Sessions and in-progress transfers aren't shared between instances.
- **Preview deployments can't sign in.** Vercel preview URLs don't match `FRONTEND_URL` or the registered redirect URIs, so only the production domain works.
- **Shared YouTube quota:** every user draws from your Google project's daily quota.
- **Sign-in is limited** by Google's test-user list and Spotify's Development Mode user limit until those apps are approved for wider use.
