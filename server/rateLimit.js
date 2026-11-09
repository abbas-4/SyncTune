// Small fixed-window rate limiter kept in memory. SyncTune runs as a single
// instance (see DEPLOYMENT.md), so in-memory counts are enough; with more
// instances each would count separately.

const MAX_TRACKED_KEYS = 50000;

/**
 * @param {object} options
 * @param {number} options.windowMs  Length of one window.
 * @param {number} options.max       Requests allowed per key per window.
 */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }

  function sweep(now = Date.now()) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }

  // unref: never keeps the process alive on its own.
  setInterval(sweep, windowMs).unref();

  /** Counts one request for `key`. Returns whether it's allowed, and if not, when to retry. */
  function consume(key) {
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      // A flood of distinct keys (e.g. many IPs) can't grow the map forever.
      if (hits.size >= MAX_TRACKED_KEYS) sweep(now);
      if (hits.size >= MAX_TRACKED_KEYS) hits.delete(hits.keys().next().value);
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count++;
    const allowed = entry.count <= max;
    return {
      allowed,
      remaining: Math.max(0, max - entry.count),
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  function reset() {
    hits.clear();
  }

  return { consume, reset, max, windowMs };
}

/**
 * Express middleware around a limiter. `key(req)` picks what to count by
 * (an IP or a session ID); returning nothing skips counting. `onLimit` sends
 * the response when the limit is hit.
 */
function rateLimitMiddleware(limiter, { key, onLimit }) {
  return (req, res, next) => {
    const id = key(req);
    if (!id) return next();

    const result = limiter.consume(id);
    if (result.allowed) return next();

    res.set("Retry-After", String(result.retryAfterSec));
    return onLimit(req, res, result);
  };
}

module.exports = { createRateLimiter, rateLimitMiddleware };
