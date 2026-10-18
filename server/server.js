
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const crypto = require("crypto");
const { google } = require("googleapis");
const {
  buildSearchQuery,
  decodeHtmlEntities,
  parseIsoDuration,
  pickBestMatch,
} = require("./youtubeMatch");
const { registerSpotifyRoutes } = require("./spotify");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = "http://localhost:5173";
const REDIRECT_URI = `http://localhost:${PORT}/oauth2/callback`;

if (
  !process.env.GOOGLE_CLIENT_ID ||
  !process.env.GOOGLE_CLIENT_SECRET ||
  !process.env.SESSION_SECRET
) {
  throw new Error(
    "Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or SESSION_SECRET in server/.env"
  );
}

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

// Shared client for building auth URLs and exchanging codes only. API calls
// get their own client so credentials never leak between sessions.
const oauth2Client = createOAuthClient();

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

async function saveSessionQuietly(req) {
  try {
    await saveSession(req);
  } catch (error) {
    console.error("Session save failed:", error.message);
  }
}

// A YouTube API client for this request's session. Per-request, so refreshed
// tokens land in this session only.
function youtubeForSession(req) {
  const authClient = createOAuthClient();
  authClient.setCredentials(req.session.youtubeTokens);

  let tokensRefreshed = false;

  // Google usually omits refresh_token on refresh; merging keeps the old one.
  authClient.on("tokens", (newTokens) => {
    req.session.youtubeTokens = {
      ...req.session.youtubeTokens,
      ...newTokens,
    };
    tokensRefreshed = true;
  });

  return {
    youtube: google.youtube({ version: "v3", auth: authClient }),
    wasRefreshed: () => tokensRefreshed,
    // Persist refreshed tokens before responding, even if a later call failed.
    saveIfRefreshed: () =>
      tokensRefreshed ? saveSessionQuietly(req) : Promise.resolve(),
  };
}

// googleapis throws a GaxiosError carrying Google's HTTP status and reason
// (e.g. quotaExceeded, accessNotConfigured). Pull those out for logs and the
// dashboard, but never error.config: it holds the Authorization header.
function describeGoogleError(error) {
  const googleError = error.response?.data?.error;
  const reason = googleError?.errors?.[0]?.reason ?? googleError?.status;
  const message = googleError?.message ?? error.message;

  let userMessage = null;
  if (reason === "quotaExceeded") {
    userMessage =
      "SyncTune has used up today's YouTube API quota. It resets at midnight Pacific time; anything already done is kept.";
  } else if (isTransientYouTubeError(error)) {
    userMessage = `YouTube was temporarily unavailable (${reason}: ${message}) and still failed after several automatic retries. Wait a minute, then try again.`;
  } else if (googleError) {
    userMessage = `YouTube API error${reason ? ` (${reason})` : ""}: ${message}`;
  }

  return {
    reason,
    httpStatus: googleError ? 502 : 500,
    userMessage,
    log: {
      googleStatus: error.response?.status,
      reason,
      message,
      request: error.config
        ? `${error.config.method} ${new URL(error.config.url).pathname}`
        : undefined,
    },
  };
}

// Temporary YouTube failures worth retrying. Notably, playlistItems.insert
// answers 409 "The operation was aborted" (reason SERVICE_UNAVAILABLE) for a
// few seconds after a playlist is created. Quota and permission errors are not
// temporary and are not retried.
function isTransientYouTubeError(error) {
  const status = error.response?.status;
  const googleError = error.response?.data?.error;
  const reasons = [googleError?.errors?.[0]?.reason, googleError?.status];

  return (
    [500, 502, 503, 504].includes(status) ||
    reasons.some((reason) =>
      ["SERVICE_UNAVAILABLE", "ABORTED", "UNAVAILABLE", "backendError"].includes(reason)
    ) ||
    (status === 409 && /aborted/i.test(googleError?.message ?? ""))
  );
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

// googleapis only retries GET-style calls, so POSTs such as
// playlistItems.insert are retried here. An aborted (409) call wasn't applied,
// so retrying it can't add a video twice.
async function withTransientRetry(label, call) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const delayMs = RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isTransientYouTubeError(error)) throw error;

      console.warn(`${label}: temporary YouTube error, retrying`, {
        attempt: attempt + 1,
        delayMs,
        ...describeGoogleError(error).log,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);

app.use(express.json());

app.use(
  session({
    name: "synctune.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // Local development only; use HTTPS in production.
      maxAge: 60 * 60 * 1000,
    },
  })
);

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    message: "SyncTune backend is running!",
  });
});

// Begin Google authorization.
app.get("/auth/youtube", (req, res) => {
  const state = crypto.randomBytes(32).toString("hex");
  req.session.oauthState = state;

  const authorizationUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/youtube"],
    state,
  });

  res.redirect(authorizationUrl);
});

// Google returns here after the user approves or denies access.
app.get("/oauth2/callback", async (req, res) => {
  try {
    if (req.query.error) {
      return res.status(400).send(
        "Google authorization was cancelled or denied. You can close this page."
      );
    }

    const returnedState = req.query.state;
    const savedState = req.session.oauthState;

    if (
      typeof returnedState !== "string" ||
      !savedState ||
      returnedState !== savedState
    ) {
      return res.status(403).send(
        "OAuth state verification failed. Please try connecting again."
      );
    }

    delete req.session.oauthState;

    if (typeof req.query.code !== "string") {
      return res.status(400).send("Google did not return an authorization code.");
    }

    const { tokens } = await oauth2Client.getToken(req.query.code);
    req.session.youtubeTokens = tokens;

    // Scopes and token presence only; never log the tokens themselves.
    console.log("YouTube connected:", {
      grantedScopes: tokens.scope,
      hasRefreshToken: Boolean(tokens.refresh_token),
    });

    req.session.save((error) => {
      if (error) {
        console.error("Session save failed:", error.message);
        return res.status(500).send("Could not save the YouTube connection.");
      }

      res.redirect(`${FRONTEND_URL}/?youtube=connected`);
    });
  } catch (error) {
    console.error("OAuth callback failed:", error.message);
    res.status(500).send(
      "YouTube authorization failed. Check the server terminal for details."
    );
  }
});

// Check whether this browser session is connected. Reads the session only
// (no YouTube API call) and reports token presence, never token values.
app.get("/api/youtube/status", (req, res) => {
  const tokens = req.session.youtubeTokens;
  const hasAccessToken = Boolean(tokens?.access_token);
  const hasRefreshToken = Boolean(tokens?.refresh_token);
  const accessTokenExpired = Boolean(
    tokens?.expiry_date && tokens.expiry_date < Date.now()
  );

  res.json({
    // An expired access token is still usable when it can be refreshed.
    connected: hasAccessToken && (!accessTokenExpired || hasRefreshToken),
    hasRefreshToken,
    accessTokenExpired,
  });
});

// Match one song (title + artist) to a YouTube video. Search only: this never
// creates or changes anything on YouTube. An uncached song costs about 100
// quota units, so results are cached in memory while the server runs.
const matchCache = new Map();
const MATCH_CACHE_LIMIT = 2000;

app.post("/api/youtube/match", async (req, res) => {
  if (!req.session.youtubeTokens?.access_token) {
    return res.status(401).json({
      error: "Connect your YouTube account first.",
    });
  }

  const { title, artist = "", durationSec = 0 } = req.body || {};

  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 300 ||
    typeof artist !== "string" ||
    artist.length > 300 ||
    typeof durationSec !== "number" ||
    !Number.isFinite(durationSec) ||
    durationSec < 0 ||
    durationSec > 6 * 60 * 60
  ) {
    return res.status(400).json({
      error: "Send a track title, plus optionally an artist and a length in seconds.",
    });
  }

  const track = {
    title: title.trim(),
    artist: artist.trim(),
    durationSec: Math.round(durationSec),
  };
  const cacheKey = JSON.stringify([
    track.title.toLowerCase(),
    track.artist.toLowerCase(),
    track.durationSec,
  ]);

  if (matchCache.has(cacheKey)) {
    return res.json({ ...matchCache.get(cacheKey), cached: true });
  }

  const { youtube, saveIfRefreshed, wasRefreshed } = youtubeForSession(req);

  try {
    const search = await youtube.search.list({
      part: ["snippet"],
      q: buildSearchQuery(track.title, track.artist),
      type: ["video"],
      maxResults: 5,
    });

    const items = (search.data.items ?? []).filter((item) => item.id?.videoId);

    // Lengths for all five results cost 1 unit; only useful when we know the song's length.
    const lengths = new Map();
    if (track.durationSec > 0 && items.length > 0) {
      const details = await youtube.videos.list({
        part: ["contentDetails"],
        id: items.map((item) => item.id.videoId),
      });
      for (const video of details.data.items ?? []) {
        lengths.set(video.id, parseIsoDuration(video.contentDetails?.duration));
      }
    }

    const candidates = items.map((item) => ({
      videoId: item.id.videoId,
      title: decodeHtmlEntities(item.snippet?.title),
      channel: decodeHtmlEntities(item.snippet?.channelTitle),
      durationSec: lengths.get(item.id.videoId) ?? 0,
    }));

    const result = pickBestMatch(track, candidates);

    if (matchCache.size >= MATCH_CACHE_LIMIT) {
      matchCache.delete(matchCache.keys().next().value);
    }
    matchCache.set(cacheKey, result);

    console.log("Track matched:", {
      track: `${track.artist} - ${track.title}`,
      outcome: result.outcome,
      confidence: result.confidence,
      videoId: result.videoId,
    });

    await saveIfRefreshed();
    res.json({ ...result, cached: false });
  } catch (error) {
    const failure = describeGoogleError(error);

    console.error("Track matching failed:", {
      ...failure.log,
      track: `${track.artist} - ${track.title}`,
      tokensRefreshed: wasRefreshed(),
    });

    await saveIfRefreshed();
    res.status(failure.httpStatus).json({
      error: failure.userMessage ?? "Could not search YouTube for this track.",
      reason: failure.reason,
    });
  }
});

// Create a YouTube playlist and add video IDs to it.
//
// Retry-safe when the dashboard sends a transferId: the first call creates the
// playlist and remembers it in this session; later calls with the same
// transferId reuse that playlist and skip videos it already added. Without a
// transferId (the test panel), every call creates a new playlist.
const TRANSFER_ID_PATTERN = /^[\w-]{8,64}$/;
const PLAYLIST_ID_PATTERN = /^[\w-]{10,64}$/;
const transfersInFlight = new Set();

app.post("/api/youtube/playlists", async (req, res) => {
  const tokens = req.session.youtubeTokens;

  if (!tokens?.access_token) {
    return res.status(401).json({
      error: "Connect your YouTube account first.",
    });
  }

  const {
    title,
    description = "",
    privacyStatus = "private",
    videoIds = [],
    transferId,
    playlistId: knownPlaylistId,
  } = req.body || {};

  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "A playlist title is required." });
  }

  if (
    typeof description !== "string" ||
    !["private", "unlisted", "public"].includes(privacyStatus) ||
    !Array.isArray(videoIds) ||
    videoIds.length > 100 ||
    !videoIds.every(
      (id) => typeof id === "string" && /^[\w-]{11}$/.test(id)
    ) ||
    (transferId !== undefined &&
      (typeof transferId !== "string" || !TRANSFER_ID_PATTERN.test(transferId))) ||
    (knownPlaylistId !== undefined &&
      (!transferId ||
        typeof knownPlaylistId !== "string" ||
        !PLAYLIST_ID_PATTERN.test(knownPlaylistId)))
  ) {
    return res.status(400).json({
      error: "Invalid description, privacy setting, YouTube video IDs, or transfer ID.",
    });
  }

  // One request per transfer at a time, so a double click can't make two playlists.
  const lockKey = transferId ? `${req.sessionID}:${transferId}` : null;
  if (lockKey && transfersInFlight.has(lockKey)) {
    return res.status(409).json({
      error: "This transfer is already being added to YouTube. Wait for it to finish.",
    });
  }
  if (lockKey) transfersInFlight.add(lockKey);

  const { youtube, wasRefreshed } = youtubeForSession(req);
  const transfers = (req.session.transfers ??= {});
  let transfer = transferId ? transfers[transferId] : undefined;
  const reusedPlaylist = Boolean(transfer || knownPlaylistId);
  let createdPlaylist = false;
  let added = 0;
  const skippedVideoIds = [];

  try {
    if (!transfer && knownPlaylistId) {
      // The dashboard already made a playlist for this transfer, but this
      // session forgot it (e.g. the server restarted). Pick it back up and
      // read what's in it, instead of creating a duplicate.
      transfer = {
        playlistId: knownPlaylistId,
        addedVideoIds: await listPlaylistVideoIds(youtube, knownPlaylistId),
      };
      transfers[transferId] = transfer;
    }

    if (!transfer) {
      const created = await youtube.playlists.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: {
            title: title.trim(),
            description,
          },
          status: { privacyStatus },
        },
      });

      const playlistId = created.data.id;

      if (!playlistId) {
        throw new Error("YouTube did not return a playlist ID.");
      }

      // The playlist lands on whichever channel granted OAuth access, which may
      // not be the account the user is browsing YouTube with. Report it.
      const { channelId, channelTitle } = created.data.snippet ?? {};

      transfer = { playlistId, channelId, channelTitle, addedVideoIds: [] };
      if (transferId) transfers[transferId] = transfer;
      createdPlaylist = true;

      console.log("Playlist created:", {
        playlistId,
        channelId,
        channelTitle,
        privacyStatus: created.data.status?.privacyStatus,
        transferId,
      });
    }

    const alreadyAdded = new Set(transfer.addedVideoIds);

    for (const videoId of videoIds) {
      if (alreadyAdded.has(videoId)) {
        skippedVideoIds.push(videoId);
        continue;
      }

      await withTransientRetry("Adding a video to the playlist", () =>
        youtube.playlistItems.insert({
          part: ["snippet"],
          requestBody: {
            snippet: {
              playlistId: transfer.playlistId,
              resourceId: {
                kind: "youtube#video",
                videoId,
              },
            },
          },
        })
      );
      transfer.addedVideoIds.push(videoId);
      alreadyAdded.add(videoId);
      added++;
    }

    if (videoIds.length > 0) {
      console.log("Videos added to playlist:", {
        playlistId: transfer.playlistId,
        added,
        alreadyThere: skippedVideoIds.length,
        totalInTransfer: transfer.addedVideoIds.length,
      });
    }

    await saveSessionQuietly(req);

    res.json({
      success: true,
      ...playlistSummary(transfer),
      createdPlaylist,
      reusedPlaylist,
      addedVideos: added,
      skippedVideoIds,
    });
  } catch (error) {
    const failure = describeGoogleError(error);
    const playlistGone = failure.reason === "playlistNotFound";

    // The remembered playlist was deleted on YouTube: forget it so a retry starts fresh.
    if (transferId && playlistGone) delete transfers[transferId];

    console.error("Playlist update failed:", {
      ...failure.log,
      transferId,
      playlistId: transfer?.playlistId,
      addedThisRequest: added,
      accessTokenExpired: Boolean(
        tokens.expiry_date && tokens.expiry_date < Date.now()
      ),
      hasRefreshToken: Boolean(tokens.refresh_token),
      tokensRefreshed: wasRefreshed(),
    });

    await saveSessionQuietly(req);

    // Progress so far is returned too, so the dashboard can show it and retry.
    res.status(failure.httpStatus).json({
      error: playlistGone
        ? "That YouTube playlist no longer exists. Try again to create a new one."
        : failure.userMessage ??
          "Could not complete playlist creation. Check the server terminal and YouTube API settings.",
      reason: failure.reason,
      ...(transfer && !playlistGone ? playlistSummary(transfer) : {}),
    });
  } finally {
    if (lockKey) transfersInFlight.delete(lockKey);
  }
});

function playlistSummary(transfer) {
  return {
    playlistId: transfer.playlistId,
    playlistUrl: `https://www.youtube.com/playlist?list=${transfer.playlistId}`,
    channelId: transfer.channelId,
    channelTitle: transfer.channelTitle,
    addedVideoIds: transfer.addedVideoIds,
  };
}

// Video IDs already in a playlist. 1 quota unit per page of 50.
async function listPlaylistVideoIds(youtube, playlistId) {
  const videoIds = [];
  let pageToken;

  for (let page = 0; page < 20; page++) {
    const response = await youtube.playlistItems.list({
      part: ["contentDetails"],
      playlistId,
      maxResults: 50,
      pageToken,
    });

    for (const item of response.data.items ?? []) {
      if (item.contentDetails?.videoId) videoIds.push(item.contentDetails.videoId);
    }

    pageToken = response.data.nextPageToken;
    if (!pageToken) break;
  }

  return videoIds;
}

// Spotify sign-in and playlist import (server/spotify.js). Optional: without
// SPOTIFY_CLIENT_ID/SECRET in .env these routes report "not set up".
registerSpotifyRoutes(app, {
  port: PORT,
  frontendUrl: FRONTEND_URL,
  saveSessionQuietly,
});

app.listen(PORT, () => {
  console.log(`SyncTune server running at http://localhost:${PORT}`);
});
