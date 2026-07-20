/**
 * Shared password + session-cookie helpers for every gated area
 * (3 visitor download pages, 3 per-section file admins, 1 blog admin).
 *
 * Sessions are a signed, HttpOnly cookie: base64url(JSON payload) +
 * "." + base64url(HMAC-SHA256 signature), using env.SESSION_SECRET.
 * No server-side session store needed — the signature is what makes
 * the cookie trustworthy.
 */

import { escapeHtml } from "./util.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function base64url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signSession(payload, secret) {
  const payloadB64 = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${base64url(sig)}`;
}

async function verifySession(token, secret) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64urlDecode(sigB64),
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
    if (!payload || typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function cookieName(area) {
  return `session_${area}`;
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export async function requireSession(request, area, secret) {
  const cookies = parseCookies(request);
  const payload = await verifySession(cookies[cookieName(area)], secret);
  return !!(payload && payload.area === area);
}

export async function loginCookieHeader(area, secret) {
  const exp = Date.now() + SESSION_TTL_MS;
  const token = await signSession({ area, exp }, secret);
  return `${cookieName(area)}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function checkPassword(submitted, expected) {
  if (!submitted || !expected) return false;
  const [a, b] = await Promise.all([sha256Hex(submitted), sha256Hex(expected)]);
  return timingSafeEqualHex(a, b);
}

export function loginFormHtml({ heading, action, error }) {
  return `
    <p class="eyebrow">Protected Area</p>
    <h1>${escapeHtml(heading)}</h1>
    ${error ? `<p class="error-msg">${escapeHtml(error)}</p>` : ""}
    <form method="POST" action="${action}" class="login-form">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required autofocus />
      <button type="submit" class="btn btn-primary">Unlock</button>
    </form>
  `;
}
