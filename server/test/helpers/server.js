// Starts server.js in a child process with fake credentials and fake
// upstreams (fake-upstreams.cjs), and gives tests a tiny cookie-keeping client.

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const SERVER = path.join(__dirname, "..", "..", "server.js");
const PRELOAD = path.join(__dirname, "fake-upstreams.cjs");

// Values that must never appear in any response the server sends.
const SECRETS = {
  GOOGLE_CLIENT_SECRET: "FAKE_GOOGLE_CLIENT_SECRET_DO_NOT_LEAK",
  SPOTIFY_CLIENT_SECRET: "FAKE_SPOTIFY_CLIENT_SECRET_DO_NOT_LEAK",
  SESSION_SECRET: "FAKE_SESSION_SECRET_DO_NOT_LEAK_0123456789abcdef",
};
const FAKE_TOKENS = require("./fake-tokens.cjs");
const NEVER_IN_RESPONSES = [...Object.values(SECRETS), ...Object.values(FAKE_TOKENS)];

const FRONTEND = "http://localhost:5173";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  // An empty working directory, so dotenv can't load a real server/.env.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synctune-test-"));
  const upstreamLog = path.join(cwd, "upstream.log");
  fs.writeFileSync(upstreamLog, "");

  const env = {
    PATH: process.env.PATH,
    PORT: String(port),
    GOOGLE_CLIENT_ID: "fake-client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: SECRETS.GOOGLE_CLIENT_SECRET,
    SESSION_SECRET: SECRETS.SESSION_SECRET,
    SPOTIFY_CLIENT_ID: "fakespotifyclientid",
    SPOTIFY_CLIENT_SECRET: SECRETS.SPOTIFY_CLIENT_SECRET,
    FRONTEND_URL: FRONTEND,
    GOOGLE_REDIRECT_URI: `http://localhost:${port}/oauth2/callback`,
    SPOTIFY_REDIRECT_URI: `http://localhost:${port}/auth/spotify/callback`,
    FAKE_UPSTREAM_LOG: upstreamLog,
    ...extraEnv,
  };

  const child = spawn(process.execPath, ["--require", PRELOAD, SERVER], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server didn't start:\n${output}`)), 10000);
    const check = () => {
      if (/SyncTune server running/.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", check);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code}):\n${output}`));
    });
  });

  return {
    base: `http://127.0.0.1:${port}`,
    port,
    output: () => output,
    upstreamCalls: () =>
      fs.readFileSync(upstreamLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    stop: () =>
      new Promise((resolve) => {
        child.removeAllListeners("exit");
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

// A browser-like client: keeps cookies, doesn't follow redirects, and sends
// the dashboard's Origin on state-changing requests unless told otherwise.
function client(server) {
  const jar = new Map();

  async function request(pathname, { method = "GET", body, headers = {}, origin = FRONTEND } = {}) {
    const sendHeaders = { ...headers };
    if (jar.size) sendHeaders.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (origin && method !== "GET") sendHeaders.origin = origin;
    if (body !== undefined) sendHeaders["content-type"] ??= "application/json";

    const response = await fetch(`${server.base}${pathname}`, {
      method,
      headers: sendHeaders,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });

    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json, location: response.headers.get("location") };
  }

  return { request, jar };
}

/** Throws if a response contains any secret or token. */
function assertNoSecrets(response) {
  const everything = `${response.text}\n${[...response.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}`;
  for (const secret of NEVER_IN_RESPONSES) {
    if (everything.includes(secret)) throw new Error(`Response leaked a secret or token (${secret.slice(0, 8)}…)`);
  }
}

module.exports = { startServer, client, assertNoSecrets, FRONTEND, NEVER_IN_RESPONSES };
