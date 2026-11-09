// Security tests for the SyncTune backend. Run with `npm test` in server/.
// The server runs in a child process against fake Google/Spotify upstreams
// (test/helpers/fake-upstreams.cjs), so nothing here touches real accounts.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client, assertNoSecrets, FRONTEND, NEVER_IN_RESPONSES } = require("./helpers/server");

async function connectYouTube(server, browser) {
  const start = await browser.request("/auth/youtube");
  assert.equal(start.status, 302);
  const state = new URL(start.location).searchParams.get("state");
  const done = await browser.request(`/oauth2/callback?state=${state}&code=GOOD_GOOGLE_CODE`);
  return { start, state, done };
}

async function connectSpotify(server, browser, code = "GOOD_SPOTIFY_CODE") {
  const start = await browser.request("/auth/spotify");
  assert.equal(start.status, 302);
  const state = new URL(start.location).searchParams.get("state");
  const callback = await browser.request(`/auth/spotify/callback?state=${state}&code=${code}`);
  if (!callback.location?.startsWith("/auth/spotify/complete")) return { state, callback };
  const done = await browser.request(callback.location);
  return { state, callback, done };
}

function sessionCookie(browser) {
  return browser.jar.get("synctune.sid");
}

describe("SyncTune backend (development mode)", () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.stop();
  });

  describe("headers and error responses", () => {
    it("sends security headers and hides the framework", async () => {
      const res = await client(server).request("/api/health");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-powered-by"), null);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
      assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      assert.equal(res.headers.get("cache-control"), "no-store");
      // HSTS only in production (local development is plain http).
      assert.equal(res.headers.get("strict-transport-security"), null);
    });

    it("answers unknown routes with a JSON 404, not Express's HTML page", async () => {
      const res = await client(server).request("/no/such/route");
      assert.equal(res.status, 404);
      assert.deepEqual(res.json, { error: "Not found." });
      assert.doesNotMatch(res.text, /Cannot GET|Express|<pre>/);
    });

    it("rejects malformed JSON without a stack trace", async () => {
      const res = await client(server).request("/api/youtube/match", { method: "POST", body: "{not json" });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, "That request couldn’t be read.");
      assert.doesNotMatch(res.text, /\bat \S+ \(|node_modules|SyntaxError|\.js:\d+/);
    });

    it("rejects oversized bodies", async () => {
      const res = await client(server).request("/api/youtube/match", {
        method: "POST",
        body: JSON.stringify({ title: "x".repeat(200 * 1024) }),
      });
      assert.equal(res.status, 413);
      assert.equal(res.json.error, "That request is too large.");
    });
  });

  describe("CORS and CSRF", () => {
    it("allows the dashboard origin with credentials, and only the methods it uses", async () => {
      const res = await fetch(`${server.base}/api/youtube/match`, {
        method: "OPTIONS",
        headers: {
          origin: FRONTEND,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-requested-with",
        },
      });
      assert.equal(res.headers.get("access-control-allow-origin"), FRONTEND);
      assert.equal(res.headers.get("access-control-allow-credentials"), "true");
      assert.equal(res.headers.get("access-control-allow-methods"), "GET,POST,DELETE");
      assert.match(res.headers.get("access-control-allow-headers"), /X-Requested-With/i);
    });

    it("never allows another origin to read responses", async () => {
      const res = await fetch(`${server.base}/api/youtube/status`, { headers: { origin: "https://evil.example" } });
      // The header always names the dashboard, so browsers block every other origin.
      assert.equal(res.headers.get("access-control-allow-origin"), FRONTEND);
    });

    it("refuses state-changing requests from another origin", async () => {
      const res = await client(server).request("/api/youtube/disconnect", { method: "POST", origin: "https://evil.example" });
      assert.equal(res.status, 403);
    });

    it("refuses state-changing requests with neither Origin nor the dashboard header", async () => {
      const res = await client(server).request("/api/youtube/match-cache", { method: "DELETE", origin: null });
      assert.equal(res.status, 403);
    });

    it("accepts the dashboard header when Origin was stripped", async () => {
      const res = await client(server).request("/api/youtube/match-cache", {
        method: "DELETE",
        origin: null,
        headers: { "x-requested-with": "SyncTune" },
      });
      assert.equal(res.status, 200);
    });
  });

  describe("authentication is required", () => {
    for (const [method, path, body] of [
      ["POST", "/api/youtube/match", { title: "Song" }],
      ["POST", "/api/youtube/playlists", { title: "Playlist" }],
      ["GET", "/api/spotify/playlists"],
      ["GET", "/api/spotify/playlists/37i9dQZF1DXcBWIGoYBM5M"],
    ]) {
      it(`${method} ${path} without a sign-in returns 401`, async () => {
        const res = await client(server).request(path, { method, body });
        assert.equal(res.status, 401);
        assertNoSecrets(res);
      });
    }

    it("status endpoints report only a boolean and never token values", async () => {
      const browser = client(server);
      await connectYouTube(server, browser);
      const res = await browser.request("/api/youtube/status");
      assert.deepEqual(res.json, { connected: true });
      assertNoSecrets(res);
    });
  });

  describe("Google / YouTube OAuth", () => {
    it("starts sign-in with a random state and the configured redirect URI, and no secret", async () => {
      const res = await client(server).request("/auth/youtube");
      assert.equal(res.status, 302);
      const url = new URL(res.location);
      assert.equal(url.host, "accounts.google.com");
      assert.equal(url.searchParams.get("redirect_uri"), `http://localhost:${server.port}/oauth2/callback`);
      assert.match(url.searchParams.get("state"), /^[0-9a-f]{64}$/);
      assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/youtube");
      assertNoSecrets(res);
    });

    it("rejects a callback without the session's state", async () => {
      const browser = client(server);
      await browser.request("/auth/youtube");
      const res = await browser.request(`/oauth2/callback?state=${"0".repeat(64)}&code=GOOD_GOOGLE_CODE`);
      assert.equal(res.location, `${FRONTEND}/?youtube=expired`);
      assert.equal((await browser.request("/api/youtube/status")).json.connected, false);
    });

    it("rejects a callback from a browser that never started sign-in (login CSRF)", async () => {
      const victim = client(server);
      const attacker = client(server);
      const start = await attacker.request("/auth/youtube");
      const state = new URL(start.location).searchParams.get("state");
      const res = await victim.request(`/oauth2/callback?state=${state}&code=GOOD_GOOGLE_CODE`);
      assert.equal(res.location, `${FRONTEND}/?youtube=expired`);
      assert.equal((await victim.request("/api/youtube/status")).json.connected, false);
    });

    it("sends cancelled and failed sign-ins back to the dashboard with a result code only", async () => {
      const browser = client(server);
      const denied = await browser.request("/oauth2/callback?error=access_denied");
      assert.equal(denied.location, `${FRONTEND}/?youtube=denied`);

      const start = await browser.request("/auth/youtube");
      const state = new URL(start.location).searchParams.get("state");
      const failed = await browser.request(`/oauth2/callback?state=${state}&code=BAD_CODE`);
      assert.equal(failed.location, `${FRONTEND}/?youtube=failed`);
      assert.doesNotMatch(failed.text, /invalid_grant|BAD_CODE/);
    });

    it("connects, rotates the session ID, and can't be replayed", async () => {
      const browser = client(server);
      await browser.request("/auth/youtube");
      const preSignIn = sessionCookie(browser);
      const state = new URL((await browser.request("/auth/youtube")).location).searchParams.get("state");
      const done = await browser.request(`/oauth2/callback?state=${state}&code=GOOD_GOOGLE_CODE`);
      assert.equal(done.location, `${FRONTEND}/?youtube=connected`);
      assert.notEqual(sessionCookie(browser), preSignIn, "session ID should change on sign-in");
      assert.equal((await browser.request("/api/youtube/status")).json.connected, true);

      const replay = await browser.request(`/oauth2/callback?state=${state}&code=GOOD_GOOGLE_CODE`);
      assert.equal(replay.location, `${FRONTEND}/?youtube=expired`);
    });

    it("the pre-sign-in session ID gets nothing (session fixation)", async () => {
      const browser = client(server);
      await browser.request("/auth/youtube");
      const planted = sessionCookie(browser);
      const state = new URL((await browser.request("/auth/youtube")).location).searchParams.get("state");
      await browser.request(`/oauth2/callback?state=${state}&code=GOOD_GOOGLE_CODE`);

      const attacker = client(server);
      attacker.jar.set("synctune.sid", planted);
      assert.equal((await attacker.request("/api/youtube/status")).json.connected, false);
    });

    it("disconnecting revokes the token at Google and forgets it", async () => {
      const browser = client(server);
      await connectYouTube(server, browser);
      const res = await browser.request("/api/youtube/disconnect", { method: "POST" });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { connected: false });

      const revoke = server.upstreamCalls().filter((call) => call.path === "/revoke");
      assert.ok(revoke.length > 0, "Google revoke endpoint should be called");
      assert.equal((await browser.request("/api/youtube/status")).json.connected, false);
      assert.equal((await browser.request("/api/youtube/match", { method: "POST", body: { title: "Song" } })).status, 401);
    });
  });

  describe("YouTube endpoints", () => {
    let browser;

    before(async () => {
      browser = client(server);
      await connectYouTube(server, browser);
    });

    it("validates match input", async () => {
      for (const body of [{}, { title: "" }, { title: 5 }, { title: "x".repeat(301) }, { title: "a", durationSec: -1 }, { title: "a", artist: {} }]) {
        const res = await browser.request("/api/youtube/match", { method: "POST", body });
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
      }
    });

    it("matches without saying whether someone else already searched the song", async () => {
      const first = await browser.request("/api/youtube/match", { method: "POST", body: { title: "Cache Probe", artist: "Fake Artist", durationSec: 200 } });
      assert.equal(first.status, 200);
      assert.equal(first.json.cached, undefined);

      const other = client(server);
      await connectYouTube(server, other);
      const second = await other.request("/api/youtube/match", { method: "POST", body: { title: "Cache Probe", artist: "Fake Artist", durationSec: 200 } });
      assert.equal(second.status, 200);
      assert.equal(second.json.cached, undefined);
      assert.deepEqual(second.json, first.json);
    });

    it("keeps Google's internal error text (e.g. the project number) out of responses", async () => {
      const res = await browser.request("/api/youtube/match", { method: "POST", body: { title: "NOTCONFIGURED" } });
      assert.equal(res.status, 502);
      assert.equal(res.json.error, "YouTube couldn’t complete this request. Please try again later.");
      assert.equal(res.json.reason, undefined);
      assert.doesNotMatch(res.text, /123456789012|project|accessNotConfigured/);
    });

    it("still explains quota errors", async () => {
      const res = await browser.request("/api/youtube/match", { method: "POST", body: { title: "QUOTA" } });
      assert.equal(res.status, 502);
      assert.equal(res.json.reason, "quotaExceeded");
      assert.match(res.json.error, /quota/);
    });

    it("creates a playlist and validates its input", async () => {
      const ok = await browser.request("/api/youtube/playlists", {
        method: "POST",
        body: { title: "My list", videoIds: ["dQw4w9WgXcQ"], transferId: "123e4567-e89b-12d3-a456-426614174000" },
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.playlistUrl, "https://www.youtube.com/playlist?list=PLfakeplaylist000001");
      assertNoSecrets(ok);

      for (const body of [
        { title: "x".repeat(151) },
        { title: "ok", description: "x".repeat(5001) },
        { title: "ok", privacyStatus: "everyone" },
        { title: "ok", videoIds: ["not-a-video-id"] },
        { title: "ok", videoIds: Array(101).fill("dQw4w9WgXcQ") },
        { title: "ok", transferId: "__proto__" },
        { title: "ok", playlistId: "PLfakeplaylist000001" },
      ]) {
        const res = await browser.request("/api/youtube/playlists", { method: "POST", body });
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 50));
      }
    });

    it("isn't confused by transfer IDs that name Object.prototype properties", async () => {
      const res = await browser.request("/api/youtube/playlists", {
        method: "POST",
        body: { title: "Proto", videoIds: ["dQw4w9WgXcQ"], transferId: "constructor" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.createdPlaylist, true);
    });
  });

  describe("match cache isolation", () => {
    it("one user can't see or delete another user's cached songs", async () => {
      const alice = client(server);
      const bob = client(server);
      await connectYouTube(server, alice);
      await connectYouTube(server, bob);

      await alice.request("/api/youtube/match", { method: "POST", body: { title: "Alice Only", artist: "Fake Artist" } });
      const aliceCache = await alice.request("/api/youtube/match-cache");
      const entry = aliceCache.json.entries.find((e) => e.title === "Alice Only");
      assert.ok(entry);

      const bobCache = await bob.request("/api/youtube/match-cache");
      assert.equal(bobCache.json.entries.some((e) => e.title === "Alice Only"), false);

      const steal = await bob.request(`/api/youtube/match-cache/${entry.id}`, { method: "DELETE" });
      assert.equal(steal.status, 404);
      assert.ok((await alice.request("/api/youtube/match-cache")).json.entries.some((e) => e.id === entry.id));
    });

    it("keeps a user's cached songs (shared and private) across a re-sign-in", async () => {
      const carol = client(server);
      const dave = client(server);
      await connectYouTube(server, carol);
      await connectYouTube(server, dave);

      const song = { title: "Shared Song", artist: "Fake Artist" };
      await carol.request("/api/youtube/match", { method: "POST", body: song });
      await dave.request("/api/youtube/match", { method: "POST", body: song });
      // Carol forgets it while Dave still uses it, then matches again: a private entry.
      const id = (await carol.request("/api/youtube/match-cache")).json.entries.find((e) => e.title === "Shared Song").id;
      assert.equal((await carol.request(`/api/youtube/match-cache/${id}`, { method: "DELETE" })).status, 200);
      await carol.request("/api/youtube/match", { method: "POST", body: song });
      await carol.request("/api/youtube/match", { method: "POST", body: { title: "Carol Song", artist: "Fake Artist" } });

      await connectYouTube(server, carol); // rotates Carol's session ID

      const after = (await carol.request("/api/youtube/match-cache")).json.entries.map((e) => e.title).sort();
      assert.deepEqual(after, ["Carol Song", "Shared Song"]);
      const cleared = await carol.request("/api/youtube/match-cache", { method: "DELETE" });
      assert.equal(cleared.json.removed, 2);
      // Dave's copy is untouched.
      assert.ok((await dave.request("/api/youtube/match-cache")).json.entries.some((e) => e.title === "Shared Song"));
    });
  });

  describe("Spotify OAuth and import", () => {
    it("connects through the state handoff, rotates the session, and imports a playlist", async () => {
      const browser = client(server);
      await browser.request("/api/spotify/status");
      const { done } = await connectSpotify(server, browser);
      assert.equal(done.location, `${FRONTEND}/?spotify=connected`);

      const status = await browser.request("/api/spotify/status");
      assert.deepEqual(status.json, { configured: true, connected: true, displayName: "Fake User" });

      const list = await browser.request("/api/spotify/playlists");
      assert.equal(list.status, 200);
      const playlist = await browser.request("/api/spotify/playlists/37i9dQZF1DXcBWIGoYBM5M");
      assert.equal(playlist.status, 200);
      assert.equal(playlist.json.tracks[0].title, "Fake Song");
      for (const res of [status, list, playlist]) assertNoSecrets(res);
    });

    it("only the browser that started sign-in can claim the tokens", async () => {
      const victim = client(server);
      const attacker = client(server);
      const start = await attacker.request("/auth/spotify");
      const state = new URL(start.location).searchParams.get("state");
      const callback = await attacker.request(`/auth/spotify/callback?state=${state}&code=GOOD_SPOTIFY_CODE`);
      const claim = await victim.request(callback.location);
      assert.equal(claim.location, `${FRONTEND}/?spotify=expired`);
      assert.equal((await victim.request("/api/spotify/status")).json.connected, false);
    });

    it("rejects unknown or replayed state", async () => {
      const browser = client(server);
      const res = await browser.request(`/auth/spotify/callback?state=${"a".repeat(64)}&code=GOOD_SPOTIFY_CODE`);
      assert.equal(res.location, `${FRONTEND}/?spotify=expired`);

      const { state } = await connectSpotify(server, browser);
      const replay = await browser.request(`/auth/spotify/callback?state=${state}&code=GOOD_SPOTIFY_CODE`);
      assert.equal(replay.location, `${FRONTEND}/?spotify=expired`);
    });

    it("tells unapproved accounts so without developer-dashboard instructions", async () => {
      const browser = client(server);
      const { callback } = await connectSpotify(server, browser, "NOT_APPROVED_CODE");
      assert.equal(callback.location, `${FRONTEND}/?spotify=not-approved`);
    });

    it("validates playlist IDs (no path tricks reach Spotify)", async () => {
      const browser = client(server);
      await connectSpotify(server, browser);
      for (const id of ["..%2F..%2Fme", "abc", "x".repeat(41), "abc%3Fmarket%3DUS1234"]) {
        const res = await browser.request(`/api/spotify/playlists/${id}`);
        assert.equal(res.status, 400, id);
      }
    });

    it("disconnects", async () => {
      const browser = client(server);
      await connectSpotify(server, browser);
      const res = await browser.request("/api/spotify/disconnect", { method: "POST" });
      assert.deepEqual(res.json, { connected: false });
      assert.equal((await browser.request("/api/spotify/status")).json.connected, false);
      assert.equal((await browser.request("/api/spotify/playlists")).status, 401);
    });
  });

  describe("logs", () => {
    it("never contain tokens, secrets or authorization codes", () => {
      const output = server.output();
      for (const secret of NEVER_IN_RESPONSES) {
        assert.equal(output.includes(secret), false, `log leaked ${secret.slice(0, 8)}…`);
      }
      assert.equal(/GOOD_GOOGLE_CODE|GOOD_SPOTIFY_CODE/.test(output), false);
    });
  });
});

describe("SyncTune backend (production mode)", () => {
  let server;

  before(async () => {
    server = await startServer({
      NODE_ENV: "production",
      FRONTEND_URL: "https://app.synctune.example",
      GOOGLE_REDIRECT_URI: "https://api.synctune.example/oauth2/callback",
      SPOTIFY_REDIRECT_URI: "https://api.synctune.example/auth/spotify/callback",
      SESSION_SECRET: "short",
    });
  });

  after(async () => {
    await server.stop();
  });

  it("adds HSTS", async () => {
    const res = await client(server).request("/api/health");
    assert.match(res.headers.get("strict-transport-security"), /max-age=\d+/);
  });

  it("sets a Secure, HttpOnly, SameSite=None session cookie for a cross-site frontend", async () => {
    const res = await client(server).request("/auth/youtube", { headers: { "x-forwarded-proto": "https" } });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("synctune.sid="));
    assert.ok(cookie);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=None/);
  });

  it("warns about a short SESSION_SECRET without printing it", () => {
    assert.match(server.output(), /SESSION_SECRET is shorter than 32 characters/);
    assert.equal(server.output().includes("short\n"), false);
  });

  it("doesn't log song or channel names", async () => {
    const browser = client(server);
    const start = await browser.request("/auth/youtube", { headers: { "x-forwarded-proto": "https" } });
    const state = new URL(start.location).searchParams.get("state");
    await browser.request(`/oauth2/callback?state=${state}&code=GOOD_GOOGLE_CODE`, { headers: { "x-forwarded-proto": "https" } });
    await browser.request("/api/youtube/match", {
      method: "POST",
      origin: "https://app.synctune.example",
      headers: { "x-forwarded-proto": "https" },
      body: { title: "Very Personal Song", artist: "Fake Artist" },
    });
    assert.match(server.output(), /Track matched/);
    assert.equal(server.output().includes("Very Personal Song"), false);
  });
});

describe("rate limits", () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.stop();
  });

  it("limits sign-in starts per IP", async () => {
    let last;
    for (let i = 0; i < 61; i++) last = await client(server).request("/auth/youtube");
    assert.equal(last.status, 302);
    assert.equal(last.location, `${FRONTEND}/?youtube=busy`);
    assert.ok(Number(last.headers.get("retry-after")) > 0);
  });

  it("limits uncached YouTube searches per session, but not cached ones", async () => {
    // A fresh server: the sign-in limit above is spent for this IP.
    const fresh = await startServer();
    try {
      const browser = client(fresh);
      await connectYouTube(fresh, browser);
      for (let i = 0; i < 150; i++) {
        const res = await browser.request("/api/youtube/match", { method: "POST", body: { title: `Song ${i}` } });
        assert.equal(res.status, 200);
      }
      const limited = await browser.request("/api/youtube/match", { method: "POST", body: { title: "Song 150" } });
      assert.equal(limited.status, 429);
      assert.equal(limited.json.reason, "rateLimited");
      const cached = await browser.request("/api/youtube/match", { method: "POST", body: { title: "Song 1" } });
      assert.equal(cached.status, 200);
    } finally {
      await fresh.stop();
    }
  });
});
