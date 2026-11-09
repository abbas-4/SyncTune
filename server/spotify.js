// Spotify sign-in and playlist import. The client secret and tokens stay on
// this server; the dashboard only ever receives song titles, artists, albums
// and lengths.
//
// Spotify rules this code follows (developer.spotify.com, checked Oct 2026):
// - Redirect URIs can't use "localhost"; a local one must use 127.0.0.1. The
//   dashboard talks to the API on localhost, and browsers keep separate cookies
//   for the two, so the callback arrives without the SyncTune session. It is
//   bridged with a one-time handoff (see /auth/spotify/complete). In
//   production the callback is on the same origin as the session, and the
//   handoff simply continues there.
// - Development Mode apps can only read the songs of playlists the signed-in
//   user owns or collaborates on (since Feb 2026). Others return 403.
// - Playlist songs come from /playlists/{id}/items, and each entry's song is
//   under `item` (`track` is the deprecated name).

const crypto = require("crypto");

const ACCOUNTS_URL = "https://accounts.spotify.com";
const API_URL = "https://api.spotify.com/v1";
const SCOPES = ["playlist-read-private", "playlist-read-collaborative"];
const HANDOFF_TTL_MS = 5 * 60 * 1000;
const MAX_PAGES = 100; // 50 songs per page, so up to 5,000 songs
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9]{10,40}$/;

class SpotifyError extends Error {
  constructor(message, status, reason, retryAfter) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

// What a Spotify error means for the person using the dashboard.
function friendlyMessage(error, context) {
  if (error.status === 429) {
    const wait = Number(error.retryAfter);
    return `Spotify is limiting requests right now. Try again${wait ? ` in ${wait} seconds` : " shortly"}.`;
  }
  if (isNotApproved(error)) {
    return "Your Spotify account isn’t approved for SyncTune yet. SyncTune is in limited testing, so only invited accounts can connect.";
  }
  if (context === "items" && error.status === 403) {
    return "Spotify only lets SyncTune read songs from playlists you own or collaborate on. To transfer this one, copy its songs into a playlist of your own in Spotify, then load that.";
  }
  if (context === "playlist" && error.status === 404) {
    return "Spotify couldn’t find that playlist. Check the link. Playlists made by Spotify itself (like Discover Weekly or editorial mixes) can’t be read by apps.";
  }
  if (error.status === 401 || error.reason === "reconnect" || error.reason === "invalid_grant") {
    return "Your Spotify sign-in has expired. Connect Spotify again.";
  }
  // Spotify's own error text stays in the server log.
  return "Spotify couldn’t complete this request. Please try again in a moment.";
}

// Spotify Development Mode rejects accounts not on the app's user list.
function isNotApproved(error) {
  return /not be registered|developer\.spotify\.com/i.test(error.message);
}

// Reason codes the dashboard may see; anything else stays in the log.
const PUBLIC_REASONS = new Set(["notConfigured", "notConnected", "reconnect", "rateLimited"]);

// Turns playlist entries into dashboard tracks. Skips podcast episodes and
// songs Spotify no longer returns (removed or unavailable).
function toTracks(entries, startIndex = 0) {
  const tracks = [];
  let episodes = 0;
  let unavailable = 0;

  entries.forEach((entry) => {
    const item = entry?.item ?? entry?.track;
    if (!item || !item.name) {
      unavailable++;
      return;
    }
    if (item.type === "episode") {
      episodes++;
      return;
    }
    tracks.push({
      // Index keeps IDs unique when a song appears twice in one playlist.
      id: `spotify-${startIndex + tracks.length}-${item.id ?? "local"}`,
      title: item.name,
      artist: (item.artists ?? []).map((artist) => artist?.name).filter(Boolean).join(", "),
      album: item.album?.name ?? "",
      durationSec: Math.round((item.duration_ms ?? 0) / 1000),
    });
  });

  return { tracks, episodes, unavailable };
}

function registerSpotifyRoutes(
  app,
  { port, isProduction, saveSessionQuietly, rotateSession, authResultUrl, sameSecret, devOnly }
) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri =
    process.env.SPOTIFY_REDIRECT_URI ||
    (isProduction ? "" : `http://127.0.0.1:${port}/auth/spotify/callback`);
  const configured = Boolean(clientId && clientSecret && redirectUri.startsWith(isProduction ? "https://" : "http"));

  // Where to finish sign-in: back on the origin that holds the dashboard's
  // session cookie. Locally that's localhost (the callback had to use
  // 127.0.0.1); in production the callback already is on that origin, so a
  // relative URL keeps it there, including behind a Vercel rewrite.
  const callbackHost = redirectUri ? new URL(redirectUri).hostname : "";
  const completePath = ["127.0.0.1", "[::1]"].includes(callbackHost)
    ? `http://localhost:${port}/auth/spotify/complete`
    : "/auth/spotify/complete";

  if (!configured) {
    console.log(
      clientId && clientSecret
        ? "Spotify import is off: SPOTIFY_REDIRECT_URI must be set to an https:// URL in production."
        : "Spotify import is off: add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to server/.env to turn it on."
    );
  }

  // Sign-ins in progress, keyed by their random state. The same state is also
  // saved in the session that started the sign-in. Capped, so a flood of
  // sign-in starts can't use up memory; the oldest are dropped first.
  const pendingLogins = new Map();
  const MAX_PENDING_LOGINS = 1000;

  function prunePendingLogins() {
    const now = Date.now();
    for (const [state, login] of pendingLogins) {
      if (now - login.createdAt > HANDOFF_TTL_MS) pendingLogins.delete(state);
    }
    while (pendingLogins.size >= MAX_PENDING_LOGINS) {
      pendingLogins.delete(pendingLogins.keys().next().value);
    }
  }

  async function requestToken(params) {
    const response = await fetch(`${ACCOUNTS_URL}/api/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // Spotify's error text only; never the request body (it holds the code).
      throw new SpotifyError(
        data.error_description || data.error || `HTTP ${response.status}`,
        response.status,
        data.error
      );
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      scope: data.scope,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  }

  async function spotifyRequest(accessToken, pathOrUrl) {
    const url = pathOrUrl.startsWith(API_URL) ? pathOrUrl : `${API_URL}${pathOrUrl}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new SpotifyError(
        data?.error?.message || `HTTP ${response.status}`,
        response.status,
        data?.error?.reason,
        response.headers.get("retry-after")
      );
    }
    return data;
  }

  async function refreshTokens(req) {
    const current = req.session.spotifyTokens;
    if (!current?.refresh_token) {
      throw new SpotifyError("No refresh token.", 401, "reconnect");
    }

    const fresh = await requestToken({
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
    });

    // Spotify may or may not send a new refresh token; keep the old one if not.
    req.session.spotifyTokens = {
      ...current,
      access_token: fresh.access_token,
      expires_at: fresh.expires_at,
      refresh_token: fresh.refresh_token || current.refresh_token,
      scope: fresh.scope || current.scope,
    };
    await saveSessionQuietly(req);
    return req.session.spotifyTokens;
  }

  // Calls the Web API for this session, refreshing the token when needed.
  async function spotifyApi(req, pathOrUrl) {
    let tokens = req.session.spotifyTokens;
    if (tokens.expires_at - Date.now() < 60 * 1000) tokens = await refreshTokens(req);

    try {
      return await spotifyRequest(tokens.access_token, pathOrUrl);
    } catch (error) {
      if (error.status !== 401 || !tokens.refresh_token) throw error;
      tokens = await refreshTokens(req);
      return spotifyRequest(tokens.access_token, pathOrUrl);
    }
  }

  // Safe to log: no tokens, codes or secrets.
  function logFailure(label, error, details) {
    console.error(label, {
      status: error.status,
      reason: error.reason,
      message: error.message,
      ...details,
    });
  }

  function requireSpotify(req, res) {
    if (!configured) {
      res.status(503).json({
        error: "Spotify sign-in isn’t available right now. You can still paste your tracks.",
        reason: "notConfigured",
      });
      return false;
    }
    if (!req.session.spotifyTokens?.access_token) {
      res.status(401).json({ error: "Connect your Spotify account first.", reason: "notConnected" });
      return false;
    }
    return true;
  }

  function sendError(req, res, error, context) {
    // The sign-in can't be renewed: forget it so the dashboard offers to reconnect.
    if (error.status === 401 || error.reason === "reconnect" || error.reason === "invalid_grant") {
      delete req.session.spotifyTokens;
      delete req.session.spotifyUser;
    }
    const status =
      error.reason === "invalid_grant" ? 401 : [401, 403, 404, 429].includes(error.status) ? error.status : 502;
    const reason = status === 401 ? "reconnect" : status === 429 ? "rateLimited" : error.reason;
    res.status(status).json({
      error: friendlyMessage(error, context),
      reason: PUBLIC_REASONS.has(reason) ? reason : undefined,
    });
  }

  // 1. Start sign-in (on the API origin, with the dashboard's session cookie).
  app.get("/auth/spotify", (req, res) => {
    if (!configured) {
      return res.redirect(authResultUrl("spotify", "unavailable"));
    }

    prunePendingLogins();
    const state = crypto.randomBytes(32).toString("hex");
    req.session.spotifyOAuthState = state;
    pendingLogins.set(state, { createdAt: Date.now() });

    const authorizeUrl = new URL(`${ACCOUNTS_URL}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: SCOPES.join(" "),
      redirect_uri: redirectUri,
      state,
    }).toString();

    req.session.save((error) => {
      if (error) {
        console.error("Session save failed:", error.message);
        return res.redirect(authResultUrl("spotify", "failed"));
      }
      res.redirect(authorizeUrl.toString());
    });
  });

  // 2. Spotify sends the browser to the redirect URI. Locally that's 127.0.0.1,
  // which has no SyncTune session, so nothing here relies on the cookie:
  // exchange the code, park the tokens under the one-time state, and hand back
  // to the session's origin (completePath).
  app.get("/auth/spotify/callback", async (req, res) => {
    const { state, code, error } = req.query;
    const login = typeof state === "string" ? pendingLogins.get(state) : undefined;

    if (!login || login.result || Date.now() - login.createdAt > HANDOFF_TTL_MS) {
      return res.redirect(authResultUrl("spotify", "expired"));
    }

    if (error || typeof code !== "string") {
      pendingLogins.delete(state);
      return res.redirect(authResultUrl("spotify", error === "access_denied" ? "denied" : "failed"));
    }

    try {
      const tokens = await requestToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      });
      const profile = await spotifyRequest(tokens.access_token, "/me");

      login.result = {
        tokens,
        user: { id: profile.id, displayName: profile.display_name || profile.id },
      };

      console.log("Spotify connected:", {
        grantedScopes: tokens.scope,
        hasRefreshToken: Boolean(tokens.refresh_token),
      });

      res.redirect(`${completePath}?state=${encodeURIComponent(state)}`);
    } catch (callbackError) {
      pendingLogins.delete(state);
      logFailure("Spotify sign-in failed:", callbackError, { step: "callback" });
      res.redirect(authResultUrl("spotify", isNotApproved(callbackError) ? "not-approved" : "failed"));
    }
  });

  // 3. Back with the session that started the sign-in. Only that session
  // (whose saved state matches) can claim the parked tokens.
  app.get("/auth/spotify/complete", async (req, res) => {
    const { state } = req.query;
    const login = typeof state === "string" ? pendingLogins.get(state) : undefined;

    if (!login?.result || !sameSecret(state, req.session.spotifyOAuthState)) {
      return res.redirect(authResultUrl("spotify", "expired"));
    }

    pendingLogins.delete(state);
    delete req.session.spotifyOAuthState;

    try {
      await rotateSession(req);
      req.session.spotifyTokens = login.result.tokens;
      req.session.spotifyUser = login.result.user;
      await new Promise((resolve, reject) => req.session.save((error) => (error ? reject(error) : resolve())));
      res.redirect(authResultUrl("spotify", "connected"));
    } catch (error) {
      console.error("Session save failed:", error.message);
      res.redirect(authResultUrl("spotify", "failed"));
    }
  });

  // Disconnect Spotify: forget this session's Spotify tokens and account name.
  // (Spotify has no API to revoke a token; people can remove SyncTune under
  // "Manage apps" in their Spotify account.)
  app.post("/api/spotify/disconnect", async (req, res) => {
    delete req.session.spotifyTokens;
    delete req.session.spotifyUser;
    await saveSessionQuietly(req);
    res.json({ connected: false });
  });

  // Whether Spotify is set up on the server, and connected in this session.
  app.get("/api/spotify/status", (req, res) => {
    const connected = configured && Boolean(req.session.spotifyTokens?.access_token);
    res.json({
      configured,
      connected,
      displayName: connected ? req.session.spotifyUser?.displayName : undefined,
    });
  });

  // The signed-in user's playlists, marking which ones SyncTune can read.
  app.get("/api/spotify/playlists", async (req, res) => {
    if (!requireSpotify(req, res)) return;

    const userId = req.session.spotifyUser?.id;
    const playlists = [];

    try {
      let next = "/me/playlists?limit=50";
      for (let page = 0; next && page < 20; page++) {
        const data = await spotifyApi(req, next);
        for (const playlist of data.items ?? []) {
          if (!playlist?.id) continue;
          const ownedByYou = Boolean(userId) && playlist.owner?.id === userId;
          playlists.push({
            id: playlist.id,
            name: playlist.name,
            owner: playlist.owner?.display_name || playlist.owner?.id || "",
            ownedByYou,
            collaborative: Boolean(playlist.collaborative),
            trackCount: (playlist.items ?? playlist.tracks)?.total ?? null,
          });
        }
        next = typeof data.next === "string" && data.next.startsWith(API_URL) ? data.next : null;
      }

      res.json({ playlists });
    } catch (error) {
      logFailure("Spotify playlist list failed:", error, {});
      sendError(req, res, error, "list");
    }
  });

  // One playlist's songs: title, artists, album and length. Read-only; this
  // never creates anything on Spotify or YouTube.
  app.get("/api/spotify/playlists/:id", async (req, res) => {
    if (!requireSpotify(req, res)) return;

    const { id } = req.params;
    if (!PLAYLIST_ID_PATTERN.test(id)) {
      return res.status(400).json({ error: "That isn’t a valid Spotify playlist ID." });
    }

    let step = "playlist";

    try {
      const meta = await spotifyApi(
        req,
        `/playlists/${id}?fields=id,name,collaborative,owner(id,display_name)`
      );

      step = "items";
      const tracks = [];
      let episodes = 0;
      let unavailable = 0;
      let total = 0;
      let next = `/playlists/${id}/items?limit=50&additional_types=track,episode`;

      for (let page = 0; next && page < MAX_PAGES; page++) {
        const data = await spotifyApi(req, next);
        total = data.total ?? total;
        const batch = toTracks(data.items ?? [], tracks.length);
        tracks.push(...batch.tracks);
        episodes += batch.episodes;
        unavailable += batch.unavailable;
        next = typeof data.next === "string" && data.next.startsWith(API_URL) ? data.next : null;
      }

      console.log("Spotify playlist loaded:", {
        ...devOnly({ playlistId: id, name: meta.name }),
        songs: tracks.length,
        total,
        skippedEpisodes: episodes,
        skippedUnavailable: unavailable,
      });

      res.json({
        id,
        name: meta.name,
        owner: meta.owner?.display_name || meta.owner?.id || "",
        total,
        tracks,
        skipped: { episodes, unavailable },
      });
    } catch (error) {
      logFailure("Spotify playlist import failed:", error, { ...devOnly({ playlistId: id }), step });
      sendError(req, res, error, step);
    }
  });
}

module.exports = { registerSpotifyRoutes, toTracks, friendlyMessage };
