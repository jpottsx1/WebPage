/**
 * Double opt-in: a new sign-up waits in pending_subscribers until the person
 * uses the link in their confirmation email. Only then do they join the list
 * (subscribers) and get the welcome email.
 *
 * Links are signed (HMAC of "confirm:<email>:<time>") and expire after
 * CONFIRM_DAYS. Opening the link shows a Confirm button; the POST from that
 * button does the work, so mail scanners that open every link can't confirm
 * anyone. Old pending rows are cleared by the daily scheduled job.
 */

export const CONFIRM_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

async function sign(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function confirmUrl(siteUrl, secret, email) {
  const t = Date.now();
  const token = await sign(secret, `confirm:${email}:${t}`);
  return `${siteUrl}/api/confirm?email=${encodeURIComponent(email)}&t=${t}&token=${token}`;
}

/** The email from a confirmation link, or null if it's forged or expired. */
export async function checkConfirmLink(url, secret) {
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const t = Number(url.searchParams.get("t") || "");
  const token = url.searchParams.get("token") || "";
  if (!email || !token || !secret || !Number.isFinite(t)) return null;
  if (Date.now() - t > CONFIRM_DAYS * DAY_MS || t > Date.now() + 60 * 1000) return null;
  return sameString(await sign(secret, `confirm:${email}:${t}`), token) ? email : null;
}

export async function addPending(env, email, name) {
  await env.DB
    .prepare("INSERT OR REPLACE INTO pending_subscribers (email, name, created_at) VALUES (?, ?, ?)")
    .bind(email, name, new Date().toISOString())
    .run();
}

/**
 * Moves a pending sign-up onto the list. Returns
 *   { status: "confirmed", name, createdAt }  — newly added
 *   { status: "already" }                     — already on the list
 *   { status: "missing" }                     — no pending sign-up (expired or cleared)
 */
export async function confirmPending(env, email) {
  const existing = await env.DB.prepare("SELECT email FROM subscribers WHERE email = ?").bind(email).first();
  if (existing) {
    await env.DB.prepare("DELETE FROM pending_subscribers WHERE email = ?").bind(email).run();
    return { status: "already" };
  }
  const pending = await env.DB.prepare("SELECT name FROM pending_subscribers WHERE email = ?").bind(email).first();
  if (!pending) return { status: "missing" };
  const createdAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO subscribers (email, name, created_at) VALUES (?, ?, ?)").bind(email, pending.name, createdAt),
    env.DB.prepare("DELETE FROM pending_subscribers WHERE email = ?").bind(email),
  ]);
  return { status: "confirmed", name: pending.name, createdAt };
}

/** Called by the daily scheduled job. */
export async function clearExpiredPending(env) {
  try {
    await env.DB
      .prepare("DELETE FROM pending_subscribers WHERE created_at < ?")
      .bind(new Date(Date.now() - CONFIRM_DAYS * DAY_MS).toISOString())
      .run();
  } catch (e) {
    /* table missing: the health check reports it */
  }
}
