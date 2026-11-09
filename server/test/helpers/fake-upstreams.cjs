// Preloaded into the test server (node --require). Replaces every outgoing
// HTTP request with canned Google, YouTube and Spotify answers, so the tests
// run offline and never touch real accounts. Any other host throws.
//
// Each upstream call is appended to FAKE_UPSTREAM_LOG (one JSON line), so
// tests can check what the server sent (e.g. that a token was revoked).

const fs = require("fs");
const { Gaxios } = require("gaxios");

const FAKE = require("./fake-tokens.cjs");

function log(entry) {
  if (process.env.FAKE_UPSTREAM_LOG) {
    fs.appendFileSync(process.env.FAKE_UPSTREAM_LOG, `${JSON.stringify(entry)}\n`);
  }
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function readBody(init) {
  const body = init?.body;
  if (!body) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return new Response(body).text();
}

function googleApiError(status, reason, message) {
  return json(status, { error: { code: status, message, errors: [{ reason, message }], status: reason } });
}

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  const method = (init.method ?? "GET").toUpperCase();
  const body = await readBody(init);
  const headers = new Headers(init.headers);
  log({ method, host: url.host, path: url.pathname, query: url.search, body, auth: headers.get("authorization") });

  // Google OAuth
  if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
    const params = new URLSearchParams(body);
    if (params.get("grant_type") === "authorization_code" && params.get("code") === "GOOD_GOOGLE_CODE") {
      return json(200, {
        access_token: FAKE.googleAccess,
        refresh_token: FAKE.googleRefresh,
        expires_in: 3599,
        scope: "https://www.googleapis.com/auth/youtube",
        token_type: "Bearer",
      });
    }
    return json(400, { error: "invalid_grant", error_description: "Bad Request" });
  }
  if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") {
    return json(200, {});
  }

  // YouTube Data API
  if (url.host.endsWith("googleapis.com") && url.pathname.includes("/youtube/v3/")) {
    if (headers.get("authorization") !== `Bearer ${FAKE.googleAccess}`) {
      return googleApiError(401, "authError", "Invalid Credentials");
    }
    const resource = url.pathname.split("/youtube/v3/")[1];

    if (resource === "search") {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("QUOTA")) {
        return googleApiError(403, "quotaExceeded", "The request cannot be completed because you have exceeded your quota.");
      }
      if (q.includes("NOTCONFIGURED")) {
        return googleApiError(
          403,
          "accessNotConfigured",
          "YouTube Data API v3 has not been used in project 123456789012 before or it is disabled."
        );
      }
      return json(200, {
        items: [
          { id: { videoId: "dQw4w9WgXcQ" }, snippet: { title: `Fake Artist - ${q.replace(/^Fake Artist /, "")} (Official Audio)`, channelTitle: "Fake Artist - Topic" } },
          { id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "Something else (Live)", channelTitle: "Random" } },
        ],
      });
    }
    if (resource === "videos") {
      return json(200, {
        items: (url.searchParams.get("id") ?? "").split(",").map((id) => ({ id, contentDetails: { duration: "PT3M20S" } })),
      });
    }
    if (resource === "playlists" && method === "POST") {
      const sent = JSON.parse(body || "{}");
      return json(200, {
        id: "PLfakeplaylist000001",
        snippet: { ...sent.snippet, channelId: "UCfakechannel", channelTitle: "Fake Channel" },
        status: sent.status,
      });
    }
    if (resource === "playlistItems" && method === "POST") {
      return json(200, { id: "fake-item" });
    }
    if (resource === "playlistItems" && method === "GET") {
      return json(200, { items: [{ contentDetails: { videoId: "dQw4w9WgXcQ" } }] });
    }
    return googleApiError(404, "notFound", "Not found");
  }

  // Spotify
  if (url.host === "accounts.spotify.com" && url.pathname === "/api/token") {
    const params = new URLSearchParams(body);
    if (params.get("grant_type") === "authorization_code" && params.get("code") === "GOOD_SPOTIFY_CODE") {
      return json(200, { access_token: FAKE.spotifyAccess, refresh_token: FAKE.spotifyRefresh, expires_in: 3600, scope: "playlist-read-private" });
    }
    if (params.get("grant_type") === "authorization_code" && params.get("code") === "NOT_APPROVED_CODE") {
      return json(200, { access_token: "fake-not-approved-token", expires_in: 3600 });
    }
    return json(400, { error: "invalid_grant", error_description: "Invalid authorization code" });
  }
  if (url.host === "api.spotify.com") {
    const auth = headers.get("authorization");
    if (auth === "Bearer fake-not-approved-token") {
      return json(403, { error: { status: 403, message: "Check settings on developer.spotify.com/dashboard, the user may not be registered." } });
    }
    if (auth !== `Bearer ${FAKE.spotifyAccess}`) {
      return json(401, { error: { status: 401, message: "Invalid access token" } });
    }
    const path = url.pathname.replace(/^\/v1/, "");
    if (path === "/me") return json(200, { id: "fakeuser", display_name: "Fake User" });
    if (path === "/me/playlists") {
      return json(200, {
        items: [{ id: "37i9dQZF1DXcBWIGoYBM5M", name: "Mine", owner: { id: "fakeuser", display_name: "Fake User" }, collaborative: false, items: { total: 1 } }],
        next: null,
      });
    }
    if (/^\/playlists\/[A-Za-z0-9]+$/.test(path)) {
      return json(200, { id: "37i9dQZF1DXcBWIGoYBM5M", name: "Mine", owner: { id: "fakeuser", display_name: "Fake User" } });
    }
    if (/^\/playlists\/[A-Za-z0-9]+\/items$/.test(path)) {
      return json(200, {
        total: 1,
        next: null,
        items: [{ item: { id: "track1", name: "Fake Song", type: "track", duration_ms: 200000, artists: [{ name: "Fake Artist" }], album: { name: "Fake Album" } } }],
      });
    }
    return json(404, { error: { status: 404, message: "Not found" } });
  }

  throw new Error(`Test server tried to reach an unexpected host: ${url.host}`);
}

// Spotify code uses global fetch; googleapis uses gaxios.
globalThis.fetch = fakeFetch;
const originalAdapter = Gaxios.prototype._defaultAdapter;
Gaxios.prototype._defaultAdapter = function (config) {
  return originalAdapter.call(this, { ...config, fetchImplementation: fakeFetch });
};

