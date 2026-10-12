/**
 * Cloudflare Worker — entry point
 * ------------------------------------------------------------------
 * Serves the static site and handles:
 *   POST /api/subscribe — newsletter signups (double opt-in: emails a
 *     confirmation link; GET/POST /api/confirm adds them to the list)
 *     1. Validates the submitted name + email
 *     2. Stores the subscriber in a D1 database (duplicate-safe)
 *     3. Sends a welcome email to the subscriber via Resend
 *     4. (Optional) emails the author a notification of the new signup
 *   POST /api/contact — contact form
 *     1. Validates name + email + message (honeypot field rejects bots)
 *     2. Emails the message to the author via Resend, reply-to the sender
 *   GET/POST /api/unsubscribe, /admin/newsletter — unsubscribe links and the
 *     subscriber list / newsletter sender, see src/lib/newsletter.js
 *   /admin/* — the blog CMS (src/lib/blog.js) and newsletter (src/lib/newsletter.js)
 *   /blog/* — dynamic blog, see src/lib/blog.js
 *   /robots.txt, /sitemap.xml, /blog/feed.xml — see src/lib/seo.js
 *   POST /xmlrpc, GET /rsd.xml — posting to the blog from MarsEdit,
 *     see src/lib/xmlrpc.js
 *   Anything else is a static file, or the 404 page from src/lib/layout.js.
 *   Every response gets the security headers from src/lib/headers.js.
 *
 * Required bindings / variables (set in Cloudflare dashboard):
 *   DB              — D1 database binding (declared in wrangler.jsonc)
 *   FILES           — R2 bucket binding (declared in wrangler.jsonc)
 *   RESEND_API_KEY  — secret, Resend API key
 *   FROM_EMAIL      — e.g. "Jeffrey Potts <me@jeffreypotts.ca>"
 *   NOTIFY_EMAIL    — where new-signup alerts and contact messages go
 *                     (required for /api/contact, optional for signups)
 *   ADMIN_PASSWORD_BLOG     — admin password for the blog CMS
 *   SESSION_SECRET          — random string used to sign login-session cookies
 *   BLOG_APP_USER           — username MarsEdit signs in with
 *   BLOG_APP_PASSWORD       — MarsEdit's app password (separate from ADMIN_PASSWORD_BLOG)
 *   MAILING_ADDRESS         — optional, mailing address printed in email footers (CASL)
 *   TURNSTILE_SECRET        — secret, Turnstile widget secret (see src/lib/turnstile.js)
 *   TURNSTILE_HOSTNAMES     — hostnames tokens may come from (wrangler.jsonc vars;
 *                             .dev.vars sets localhost for local testing)
 *
 * See SETUP.md for the one-time setup steps.
 */

import { logoutCookieHeader, requireSession } from "./lib/auth.js";
import { withErrorAlerts, healthCheck, scheduledHealthCheck, sendAlert } from "./lib/alerts.js";
import { confirmUrl, checkConfirmLink, addPending, confirmPending, clearExpiredPending, CONFIRM_DAYS } from "./lib/optin.js";
import { pageShell } from "./lib/layout.js";
import { handleBlogRequest } from "./lib/blog.js";
import { handleSeoRequest } from "./lib/seo.js";
import { handleXmlRpcRequest } from "./lib/xmlrpc.js";
import { handleNewsletterRequest, unsubscribeUrl, unsubscribeHeaders, emailFooterHtml } from "./lib/newsletter.js";
import { notFoundPage } from "./lib/layout.js";
import { withSecurityHeaders } from "./lib/headers.js";
import { formLimited, FORM_LIMITED_MESSAGE } from "./lib/ratelimit.js";
import { verifyTurnstile, TURNSTILE_FAILED_MESSAGE } from "./lib/turnstile.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleSubscribe(request, env) {
  if (await formLimited(env, request, "subscribe")) {
    return json(429, { error: FORM_LIMITED_MESSAGE });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { error: "Invalid request body." });
  }

  if (!(await verifyTurnstile(env, request, payload["cf-turnstile-response"], "subscribe"))) {
    return json(403, { error: TURNSTILE_FAILED_MESSAGE });
  }

  const name = (payload.name || "").toString().trim();
  const email = (payload.email || "").toString().trim().toLowerCase();

  if (!name || name.length > 120) {
    return json(400, { error: "Please provide a valid name." });
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json(400, { error: "Please provide a valid email address." });
  }

  // ---- make sure the database is wired up ----
  if (!env.DB) {
    return json(500, { error: "Database not configured. Add the D1 binding named DB." });
  }

  // ---- duplicate check ----
  try {
    const existing = await env.DB
      .prepare("SELECT email FROM subscribers WHERE email = ?")
      .bind(email)
      .first();
    if (existing) {
      return json(409, { error: "already subscribed" });
    }
  } catch (e) {
    return json(500, { error: "Could not read the subscriber list." });
  }

  // ---- double opt-in: wait for the link in the confirmation email ----
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL || !env.SESSION_SECRET) {
    return json(500, { error: "Signups aren't set up yet. Please try again later." });
  }
  try {
    await addPending(env, email, name);
    const link = await confirmUrl("https://jeffreypotts.ca", env.SESSION_SECRET, email);
    await sendEmail(env, {
      to: email,
      subject: "Please confirm your subscription",
      html: confirmHtml(name.split(/\s+/)[0] || "friend", link),
    });
  } catch (e) {
    return json(500, { error: "Couldn't send the confirmation email. Please try again in a moment." });
  }
  return json(202, { ok: true, pending: true });
}

// Adds a confirmed subscriber's welcome email and the author's notification.
async function welcomeNewSubscriber(env, email, name, createdAt) {
  const firstName = name.split(/\s+/)[0] || "friend";
  try {
    const unsubUrl = await unsubscribeUrl(env, email);
    await sendEmail(env, {
      to: email,
      subject: "Welcome to the list",
      html: welcomeHtml(env, firstName, unsubUrl),
      headers: unsubscribeHeaders(unsubUrl),
    });
  } catch (e) {
    // They're on the list either way.
  }
  if (env.NOTIFY_EMAIL) {
    try {
      await sendEmail(env, {
        to: env.NOTIFY_EMAIL,
        subject: "New newsletter signup",
        html: `<p>New subscriber (confirmed):</p><p><strong>${escapeHtml(name)}</strong><br>${escapeHtml(email)}<br>${createdAt}</p>`,
      });
    } catch (e) { /* ignore */ }
  }
}

// GET shows a Confirm button; the button's POST joins the list. Mail scanners
// open links (GET), so confirming on GET would let them confirm anyone.
async function handleConfirm(request, env, url) {
  const page = (heading, body, status = 200) =>
    new Response(pageShell({ title: "Newsletter — Jeffrey Potts", noindex: true, bodyHtml: `<p class="eyebrow">Newsletter</p><h1>${heading}</h1>${body}` }), {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  const email = await checkConfirmLink(url, env.SESSION_SECRET);
  if (!email) {
    return page("That link has expired.", `<p>Confirmation links last ${CONFIRM_DAYS} days. <a href="/#signup">Sign up again</a> and I&rsquo;ll send a fresh one.</p>`, 400);
  }
  if (request.method !== "POST") {
    return page(
      "One last step.",
      `<p>Confirm that <strong>${escapeHtml(email)}</strong> should get the newsletter.</p>
      <form method="POST" action="${escapeHtml(url.pathname + url.search)}"><button type="submit" class="btn btn-primary">Yes, sign me up</button></form>`
    );
  }
  const result = await confirmPending(env, email);
  if (result.status === "missing") {
    return page("That link has expired.", `<p><a href="/#signup">Sign up again</a> and I&rsquo;ll send a fresh one.</p>`, 400);
  }
  if (result.status === "confirmed") await welcomeNewSubscriber(env, email, result.name, result.createdAt);
  return page("You&rsquo;re on the list.", `<p>Thanks for confirming. ${result.status === "confirmed" ? "A welcome note is on its way to your inbox." : "You were already subscribed, so there&rsquo;s nothing more to do."}</p><p><a href="/">Back to the site</a> &middot; <a href="/blog/">Read the blog</a></p>`);
}

async function handleContact(request, env) {
  if (await formLimited(env, request, "contact")) {
    return json(429, { error: FORM_LIMITED_MESSAGE });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { error: "Invalid request body." });
  }

  // ---- honeypot: bots fill hidden fields; pretend success without sending ----
  if ((payload.website || "").toString().trim()) {
    return json(201, { ok: true });
  }

  if (!(await verifyTurnstile(env, request, payload["cf-turnstile-response"], "contact"))) {
    return json(403, { error: TURNSTILE_FAILED_MESSAGE });
  }

  const name = (payload.name || "").toString().trim();
  const email = (payload.email || "").toString().trim().toLowerCase();
  const message = (payload.message || "").toString().trim();

  if (!name || name.length > 120) {
    return json(400, { error: "Please provide a valid name." });
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json(400, { error: "Please provide a valid email address." });
  }
  if (!message || message.length > 5000) {
    return json(400, { error: "Please provide a message." });
  }

  if (!env.RESEND_API_KEY || !env.FROM_EMAIL || !env.NOTIFY_EMAIL) {
    return json(500, { error: "Contact form isn't configured yet." });
  }

  try {
    await sendEmail(env, {
      to: env.NOTIFY_EMAIL,
      replyTo: email,
      subject: "New message from " + name,
      html: contactHtml(name, email, message),
    });
  } catch (e) {
    return json(500, { error: "Could not send your message. Please try again." });
  }

  return json(201, { ok: true });
}

// ---- Resend email helper ----
async function sendEmail(env, { to, subject, html, replyTo, headers }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(headers ? { headers } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error("Resend failed: " + res.status);
  }
  return res;
}

function confirmHtml(firstName, link) {
  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; color:#2a2622; max-width:560px; margin:0 auto; line-height:1.6;">
    <h1 style="font-family:Arial,Helvetica,sans-serif; color:#234e58; font-size:22px;">One click to finish, ${escapeHtml(firstName)}.</h1>
    <p>Someone (hopefully you) asked to get my newsletter at this address. Confirm it and you&rsquo;re on the list:</p>
    <p style="margin:28px 0;"><a href="${escapeHtml(link)}" style="background:#b5442e; color:#fff; padding:12px 22px; text-decoration:none; font-family:Arial,Helvetica,sans-serif; font-weight:bold;">Confirm my subscription</a></p>
    <p>The link works for ${CONFIRM_DAYS} days. If you didn&rsquo;t sign up, ignore this email and you won&rsquo;t hear from me again.</p>
    <p style="margin-top:28px;">&mdash; Jeffrey Potts</p>
  </div>`;
}

function welcomeHtml(env, firstName, unsubUrl) {
  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; color:#2a2622; max-width:560px; margin:0 auto; line-height:1.6;">
    <h1 style="font-family:Arial,Helvetica,sans-serif; color:#234e58; font-size:22px;">Welcome aboard, ${escapeHtml(firstName)}.</h1>
    <p>Thank you for signing up — you&rsquo;re officially on the list.</p>
    <p>You&rsquo;ll be among the first to read new chapters and writing samples, hear about launches, and get the occasional story from behind the pages. No spam, no filler — just the work, a little early.</p>
    <p>Early chapters will arrive with the newsletter as they&rsquo;re ready. In the meantime, thank you for reading.</p>
    <p style="margin-top:28px;">— Jeffrey Potts</p>
    ${emailFooterHtml(env, unsubUrl)}
  </div>`;
}

function contactHtml(name, email, message) {
  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; color:#2a2622; max-width:560px; margin:0 auto; line-height:1.6;">
    <h1 style="font-family:Arial,Helvetica,sans-serif; color:#234e58; font-size:22px;">New message from ${escapeHtml(name)}</h1>
    <p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
    <p style="white-space: pre-wrap;">${escapeHtml(message)}</p>
    <hr style="border:none; border-top:1px solid #e3d6b8; margin:28px 0;">
    <p style="font-family:Arial,Helvetica,sans-serif; font-size:12px; color:#6f6a5c;">
      Sent from the contact form at jeffreypotts.ca. Reply directly to respond to ${escapeHtml(name)}.
    </p>
  </div>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// What the site needs to work, for the daily health check (src/lib/alerts.js).
const ALERTS = {
  site: "jeffreypotts.ca",
  defaultTo: "me@jeffreypotts.ca",
  defaultFrom: "Site alerts <alerts@jeffreypotts.ca>",
  required: [
    "DB", "FILES", "ASSETS",
    "RESEND_API_KEY", "FROM_EMAIL", "NOTIFY_EMAIL", "MAILING_ADDRESS",
    "SESSION_SECRET", "ADMIN_PASSWORD_BLOG", "BLOG_APP_USER", "BLOG_APP_PASSWORD",
    "TURNSTILE_SECRET", "TURNSTILE_HOSTNAMES",
  ],
  tables: [
    "subscribers", "pending_subscribers", "email_drafts", "newsletters", "newsletter_public", "posts", "post_tags", "post_drafts",
    "post_image_alt", "rate_events",
  ],
};

const handle = withErrorAlerts((request, env) => route(request, env), ALERTS);

export default {
  async fetch(request, env, ctx) {
    return withSecurityHeaders(await handle(request, env, ctx));
  },
  // Daily at 12:00 UTC (wrangler.jsonc triggers): email only if something's wrong.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledHealthCheck(env, ALERTS));
    ctx.waitUntil(clearExpiredPending(env));
  },
};

// /admin/health: run the daily checks now, or send a test alert.
async function handleHealth(request, env, url) {
  if (!(await requireSession(request, "admin-blog", env.SESSION_SECRET))) {
    return new Response(null, { status: 303, headers: { Location: "/admin/blog" } });
  }
  let notice = "";
  if (request.method === "POST" && url.pathname === "/admin/health/test") {
    const r = await sendAlert(env, ALERTS, { kind: "test", subject: "Test alert", lines: ["You asked for this test from /admin/health. Alerts reach you."], force: true });
    notice = r.sent ? "Test alert sent. Check your inbox." : `The test alert didn't send: ${r.reason}.`;
  }
  const problems = await healthCheck(env, ALERTS);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const bodyHtml = `
    <p class="eyebrow">Admin</p>
    <h1>Site health</h1>
    ${notice ? `<p class="notice-msg">${esc(notice)}</p>` : ""}
    ${problems.length
      ? `<p class="error-msg">${problems.length} problem${problems.length === 1 ? "" : "s"} found:</p><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
      : `<p class="notice-msg">All checks passed: settings, secrets, database tables, Resend and Turnstile.</p>`}
    <p>The same checks run every morning, and email ${esc(env.ALERT_EMAIL || env.NOTIFY_EMAIL || ALERTS.defaultTo)} if anything is wrong. Errors on the live site email it too, at most once an hour each.</p>
    <form method="POST" action="/admin/health/test"><button type="submit" class="btn btn-ghost">Send me a test alert</button></form>
    <p style="margin-top:28px;"><a href="/admin/blog">Blog</a> &middot; <a href="/admin/newsletter">Newsletter</a></p>`;
  return new Response(pageShell({ title: "Admin — Site health", noindex: true, signOut: "/admin/blog", bodyHtml }), {
    // Always 200: a 5xx here would set off the live-error alert on every visit.
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Signs out of the admin (the blog and newsletter share one session) and
// returns to the login of the page the button was on. Sessions are signed
// cookies with no server-side store, so this signs out this browser only.
function handleLogout(form) {
  const next = (form && form.get("next")) || "";
  const headers = new Headers({
    Location: ["/admin/blog", "/admin/newsletter"].includes(next) ? next : "/admin/blog",
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", logoutCookieHeader("admin-blog"));
  return new Response(null, { status: 303, headers });
}

// Admin forms only ever post from this site's own pages. A POST to /admin/*
// whose Origin is another site is a forged (CSRF) request and is refused.
// Browsers send Origin on every form POST; a request without one isn't from a
// browser page, so it can't be a CSRF attempt (and still needs the session).
function isCrossSiteAdminPost(request, url) {
  if (request.method !== "POST" || !url.pathname.startsWith("/admin/")) return false;
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== url.host;
  } catch (e) {
    return true; // "null" and other opaque origins
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  if (isCrossSiteAdminPost(request, url)) {
    return new Response("Forbidden: cross-site form submission.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (url.pathname === "/api/confirm" && (request.method === "GET" || request.method === "POST")) {
    return handleConfirm(request, env, url);
  }
  if (url.pathname === "/admin/health" || url.pathname === "/admin/health/test") {
    return handleHealth(request, env, url);
  }
  if (url.pathname === "/admin/logout" && request.method === "POST") {
    return handleLogout(await request.formData().catch(() => null));
  }
  if (url.pathname === "/api/subscribe" && request.method === "POST") {
    return handleSubscribe(request, env);
  }
  if (url.pathname === "/api/contact" && request.method === "POST") {
    return handleContact(request, env);
  }
  const newsletterResponse = await handleNewsletterRequest(request, env, url);
  if (newsletterResponse) return newsletterResponse;
  const seoResponse = await handleSeoRequest(request, env, url);
  if (seoResponse) return seoResponse;
  const xmlRpcResponse = await handleXmlRpcRequest(request, env, url, { blogName: "Jeffrey Potts", bucket: env.FILES });
  if (xmlRpcResponse) return xmlRpcResponse;
  const blogResponse = await handleBlogRequest(request, env, url);
  if (blogResponse) return blogResponse;
  const asset = await env.ASSETS.fetch(request);
  return asset.status === 404 ? notFoundPage() : asset;
}
