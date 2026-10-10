/**
 * Rate limiting, counted in D1 (the rate_events table in schema.sql).
 *
 * Passwords: after 10 wrong passwords from one IP address in 15 minutes,
 * that address can't try again until the oldest failure falls out of the
 * window. Only failures are recorded. The check runs before the password is
 * compared, so a locked-out guesser can't learn whether a guess was right.
 * One count covers every password on the site (admin, downloads, MarsEdit).
 *
 * Public forms: a few submissions per IP address per 10 minutes.
 *
 * If D1 fails (say the table hasn't been created yet), requests go through
 * rather than locking everyone out.
 */

const AUTH_MAX = 10;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const FORM_MAX = 5;
const FORM_WINDOW_MS = 10 * 60 * 1000;
const KEEP_MS = 24 * 60 * 60 * 1000;

export const AUTH_LOCKED_MESSAGE = "Too many wrong passwords. Wait 15 minutes, then try again.";
export const FORM_LIMITED_MESSAGE = "That's a lot of tries in a short time. Please wait a few minutes and try again.";

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function count(env, key, windowMs) {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND at > ?")
    .bind(key, Date.now() - windowMs)
    .first();
  return row ? row.n : 0;
}

async function record(env, key) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO rate_events (key, at) VALUES (?, ?)").bind(key, now),
    env.DB.prepare("DELETE FROM rate_events WHERE at < ?").bind(now - KEEP_MS),
  ]);
}

/** True if this IP has had too many wrong passwords recently. Check before comparing. */
export async function authLocked(env, request) {
  try {
    return (await count(env, `auth:${clientIp(request)}`, AUTH_WINDOW_MS)) >= AUTH_MAX;
  } catch (e) {
    return false;
  }
}

/** Call after a wrong password. */
export async function recordAuthFailure(env, request) {
  try {
    await record(env, `auth:${clientIp(request)}`);
  } catch (e) {
    /* fail open */
  }
}

/** Counts this submission; true if the IP is over the limit for `form`. */
export async function formLimited(env, request, form) {
  const key = `${form}:${clientIp(request)}`;
  try {
    if ((await count(env, key, FORM_WINDOW_MS)) >= FORM_MAX) return true;
    await record(env, key);
  } catch (e) {
    /* fail open */
  }
  return false;
}
