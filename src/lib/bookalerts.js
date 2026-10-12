/**
 * "Tell me when it's out": one email, once, the day a book is released.
 *
 *   POST     /api/book-alert           — {email, book, cf-turnstile-response};
 *                                        emails a confirmation link
 *   GET/POST /api/book-alert/confirm?… — GET shows a Confirm button, POST confirms
 *   GET/POST /api/book-alert/stop?…    — GET shows a Cancel button, POST cancels
 *                                        (also mail clients' one-click unsubscribe)
 *   GET      /admin/book-alerts        — who's waiting for which book
 *   POST     /admin/book-alerts/send   — send a test, or the "it's out" email
 *
 * Kept apart from the newsletter on purpose: asking to hear about one book
 * isn't agreeing to the newsletter (CASL). One book_alerts row per person per
 * book; confirmed_at stays NULL until the link is used, and unconfirmed rows
 * are cleared after CONFIRM_DAYS by the daily job. Once the "it's out" email
 * goes, that book's rows are deleted: the promise was one email.
 *
 * Releasing a book: give it its Amazon URL and remove its badge in
 * src/lib/books.js, deploy, then send the email from /admin/book-alerts.
 */

import { escapeHtml, formatDate } from "./util.js";
import { pageShell } from "./layout.js";
import { requireSession, loginFormHtml } from "./auth.js";
import { sign, sameString, CONFIRM_DAYS } from "./optin.js";
import { formLimited, FORM_LIMITED_MESSAGE } from "./ratelimit.js";
import { verifyTurnstile, TURNSTILE_FAILED_MESSAGE, TURNSTILE_SITEKEY } from "./turnstile.js";
import { BOOKS } from "./books.js";

const SITE = "https://jeffreypotts.ca";
const ADMIN_AREA = "admin-blog";
const BATCH_SIZE = 100; // Resend's batch endpoint limit
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const bookBySlug = (slug) => BOOKS.find((b) => b.slug === slug);

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function publicPage(heading, body, status = 200) {
  return html(pageShell({ title: "Book alerts — Jeffrey Potts", noindex: true, bodyHtml: `<p class="eyebrow">Book alerts</p><h1>${heading}</h1>${body}` }), status);
}

// ---- signed links ----

async function confirmLink(secret, email, book) {
  const t = Date.now();
  const token = await sign(secret, `book-alert:${book}:${email}:${t}`);
  return `${SITE}/api/book-alert/confirm?book=${book}&email=${encodeURIComponent(email)}&t=${t}&token=${token}`;
}

async function stopLink(secret, email, book) {
  const token = await sign(secret, `book-alert-stop:${book}:${email}`);
  return `${SITE}/api/book-alert/stop?book=${book}&email=${encodeURIComponent(email)}&token=${token}`;
}

/** {email, book} from a signed link, or null if it's forged, expired or for an unknown book. */
async function readLink(url, secret, kind) {
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const book = bookBySlug(url.searchParams.get("book") || "");
  const token = url.searchParams.get("token") || "";
  if (!email || !book || !token || !secret) return null;
  let expected;
  if (kind === "confirm") {
    const t = Number(url.searchParams.get("t") || "");
    if (!Number.isFinite(t) || Date.now() - t > CONFIRM_DAYS * DAY_MS || t > Date.now() + 60 * 1000) return null;
    expected = await sign(secret, `book-alert:${book.slug}:${email}:${t}`);
  } else {
    expected = await sign(secret, `book-alert-stop:${book.slug}:${email}`);
  }
  return sameString(expected, token) ? { email, book } : null;
}

// ---- email ----

async function resendPost(env, path, payload) {
  const res = await fetch(`https://api.resend.com${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status} ${text}`.trim());
  }
}

function emailWrap(inner) {
  return `<div style="font-family: Georgia, 'Times New Roman', serif; color:#2a2622; max-width:560px; margin:0 auto; line-height:1.6;">${inner}</div>`;
}

function footerHtml(env, book, stopUrl) {
  const address = env.MAILING_ADDRESS ? `<br>${escapeHtml(env.MAILING_ADDRESS)}` : "";
  return `
    <hr style="border:none; border-top:1px solid #e3d6b8; margin:28px 0;">
    <p style="font-family:Arial,Helvetica,sans-serif; font-size:12px; color:#6f6a5c;">
      You&rsquo;re getting this because you asked at jeffreypotts.ca to hear when ${escapeHtml(book.title)} came out. It&rsquo;s the only email you&rsquo;ll get about it.
      ${stopUrl ? `<a href="${escapeHtml(stopUrl)}" style="color:#6f6a5c;">Cancel this alert</a>.` : ""}${address}
    </p>`;
}

function confirmEmailHtml(book, link) {
  return emailWrap(`
    <h1 style="font-family:Arial,Helvetica,sans-serif; color:#234e58; font-size:22px;">One click to finish.</h1>
    <p>Someone (hopefully you) asked to hear when <strong>${escapeHtml(book.title)}</strong> comes out. Confirm it, and I&rsquo;ll send one email, once, on the day it&rsquo;s released:</p>
    <p style="margin:28px 0;"><a href="${escapeHtml(link)}" style="background:#b5442e; color:#fff; padding:12px 22px; text-decoration:none; font-family:Arial,Helvetica,sans-serif; font-weight:bold;">Yes, tell me when it&rsquo;s out</a></p>
    <p>The link works for ${CONFIRM_DAYS} days. This doesn&rsquo;t sign you up for my newsletter. If you didn&rsquo;t ask for it, ignore this email and you won&rsquo;t hear from me.</p>
    <p style="margin-top:28px;">&mdash; Jeffrey Potts</p>`);
}

async function releaseMessage(env, email, book, subject, bodyHtml) {
  const stop = env.SESSION_SECRET ? await stopLink(env.SESSION_SECRET, email, book.slug) : null;
  return {
    from: env.FROM_EMAIL,
    to: [email],
    subject,
    html: emailWrap(`${bodyHtml}${footerHtml(env, book, stop)}`),
    ...(stop ? { headers: { "List-Unsubscribe": `<${stop}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
  };
}

function defaultRelease(book) {
  return {
    subject: `${book.title} is out`,
    body: `<p>You asked me to tell you when <strong>${escapeHtml(book.title)}</strong> came out. It&rsquo;s out today.</p>
<p><a href="${SITE}/books/${book.slug}">Find it here</a>, with a link to buy it from Amazon in your own country.</p>
<p>Thank you for waiting for it.</p>
<p>&mdash; Jeffrey Potts</p>`,
  };
}

// ---- public: sign up, confirm, cancel ----

async function handleSignup(request, env) {
  if (await formLimited(env, request, "book-alert")) return json(429, { error: FORM_LIMITED_MESSAGE });
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { error: "Invalid request body." });
  }
  if (!(await verifyTurnstile(env, request, payload["cf-turnstile-response"], "book-alert"))) {
    return json(403, { error: TURNSTILE_FAILED_MESSAGE });
  }
  const email = (payload.email || "").toString().trim().toLowerCase();
  const book = bookBySlug((payload.book || "").toString());
  if (!book) return json(400, { error: "That book isn't one I know about." });
  if (book.amazon) return json(400, { error: `${book.title} is already out.` });
  if (!EMAIL_RE.test(email) || email.length > 254) return json(400, { error: "Please provide a valid email address." });
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL || !env.SESSION_SECRET) {
    return json(500, { error: "Alerts aren't set up yet. Please try again later." });
  }

  const existing = await env.DB
    .prepare("SELECT confirmed_at FROM book_alerts WHERE email = ? AND book_slug = ?")
    .bind(email, book.slug)
    .first();
  if (existing && existing.confirmed_at) return json(409, { error: "already" });

  try {
    await env.DB
      .prepare("INSERT OR REPLACE INTO book_alerts (email, book_slug, created_at, confirmed_at) VALUES (?, ?, ?, NULL)")
      .bind(email, book.slug, new Date().toISOString())
      .run();
    await resendPost(env, "/emails", {
      from: env.FROM_EMAIL,
      to: [email],
      subject: `Confirm: tell me when ${book.title} is out`,
      html: confirmEmailHtml(book, await confirmLink(env.SESSION_SECRET, email, book.slug)),
    });
  } catch (e) {
    return json(500, { error: "Couldn't send the confirmation email. Please try again in a moment." });
  }
  return json(202, { ok: true, pending: true });
}

// GET only shows a button: mail scanners open links, and mustn't confirm anyone.
async function handleConfirm(request, env, url) {
  const link = await readLink(url, env.SESSION_SECRET, "confirm");
  if (!link) {
    return publicPage("That link has expired.", `<p>Confirmation links last ${CONFIRM_DAYS} days. <a href="/books/">Pick the book again</a> and I&rsquo;ll send a fresh one.</p>`, 400);
  }
  const { email, book } = link;
  if (request.method !== "POST") {
    return publicPage(
      "One last step.",
      `<p>Send one email to <strong>${escapeHtml(email)}</strong> on the day <em>${escapeHtml(book.title)}</em> comes out?</p>
      <form method="POST" action="${escapeHtml(url.pathname + url.search)}"><button type="submit" class="btn btn-primary">Yes, tell me when it&rsquo;s out</button></form>`
    );
  }
  const row = await env.DB.prepare("SELECT confirmed_at FROM book_alerts WHERE email = ? AND book_slug = ?").bind(email, book.slug).first();
  if (!row) {
    return publicPage("That link has expired.", `<p><a href="/books/${book.slug}">Ask again on the book&rsquo;s page</a> and I&rsquo;ll send a fresh one.</p>`, 400);
  }
  if (!row.confirmed_at) {
    await env.DB.prepare("UPDATE book_alerts SET confirmed_at = ? WHERE email = ? AND book_slug = ?").bind(new Date().toISOString(), email, book.slug).run();
  }
  return publicPage(
    "You&rsquo;re set.",
    `<p>I&rsquo;ll email you once, on the day <em>${escapeHtml(book.title)}</em> is released. That&rsquo;s all.</p>
    <p><a href="/books/${book.slug}">Back to ${escapeHtml(book.title)}</a> &middot; <a href="/books/">All the books</a></p>`
  );
}

async function handleStop(request, env, url) {
  const isPost = request.method === "POST";
  const oneClick = isPost && !(request.headers.get("Accept") || "").includes("text/html");
  const link = await readLink(url, env.SESSION_SECRET, "stop");
  if (!link) {
    if (oneClick) return new Response(null, { status: 400 });
    return publicPage("That link isn&rsquo;t valid.", `<p>Double-check the link from the email, or <a href="/#contact">send me a note</a> and I&rsquo;ll cancel it by hand.</p>`, 400);
  }
  const { email, book } = link;
  if (!isPost) {
    return publicPage(
      "Cancel this alert?",
      `<p>Stop the email to <strong>${escapeHtml(email)}</strong> about <em>${escapeHtml(book.title)}</em>?</p>
      <form method="POST" action="${escapeHtml(url.pathname + url.search)}"><button type="submit" class="btn btn-primary">Cancel the alert</button></form>`
    );
  }
  await env.DB.prepare("DELETE FROM book_alerts WHERE email = ? AND book_slug = ?").bind(email, book.slug).run();
  if (oneClick) return new Response(null, { status: 200 });
  return publicPage("Cancelled.", `<p>You won&rsquo;t get an email about <em>${escapeHtml(book.title)}</em>.</p>`);
}

/** Called by the daily scheduled job. */
export async function clearExpiredBookAlerts(env) {
  try {
    await env.DB
      .prepare("DELETE FROM book_alerts WHERE confirmed_at IS NULL AND created_at < ?")
      .bind(new Date(Date.now() - CONFIRM_DAYS * DAY_MS).toISOString())
      .run();
  } catch (e) {
    /* table missing: the health check reports it */
  }
}

// ---- the form on an upcoming book's page ----

export function bookAlertFormHtml(book) {
  return `
      <aside class="book-alert" id="alert" aria-labelledby="ba-heading">
        <h2 id="ba-heading">Tell me when it&rsquo;s out</h2>
        <p>One email, once, the day <em>${escapeHtml(book.title)}</em> is released. It doesn&rsquo;t sign you up for the newsletter.</p>
        <form id="ba-form" novalidate>
          <label for="ba-email">Email address</label>
          <div class="ba-row">
            <input type="email" id="ba-email" name="email" autocomplete="email" maxlength="254" required />
            <button type="submit" class="btn btn-primary">Email me</button>
          </div>
          <div id="ba-turnstile" class="turnstile-slot"></div>
          <p id="ba-msg" class="ps-msg" role="status" aria-live="polite"></p>
        </form>
      </aside>
      <script>
      (function () {
        var form = document.getElementById("ba-form");
        var msg = document.getElementById("ba-msg");
        var btn = form.querySelector("button");
        var widgetId;
        // Turnstile loads once per page (with the newsletter box below); it
        // calls everything queued here when it's ready.
        (window.turnstileReady = window.turnstileReady || []).push(function () {
          widgetId = window.turnstile.render("#ba-turnstile", { sitekey: "${TURNSTILE_SITEKEY}", action: "book-alert" });
        });
        function show(state, text) { msg.dataset.state = state; msg.textContent = text; }
        form.addEventListener("submit", async function (e) {
          e.preventDefault();
          var email = document.getElementById("ba-email").value.trim();
          if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return show("err", "That email doesn\\u2019t look right \\u2014 mind checking it?");
          var token = window.turnstile && widgetId !== undefined ? window.turnstile.getResponse(widgetId) : "";
          if (!token) return show("err", "Please complete the \\u201cVerify you are human\\u201d check, then try again.");
          btn.disabled = true;
          show("", "");
          try {
            var res = await fetch("/api/book-alert", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ email: email, book: "${book.slug}", "cf-turnstile-response": token }),
            });
            var data = await res.json().catch(function () { return {}; });
            if (res.status === 202) {
              form.reset();
              show("ok", "Almost there \\u2014 check your inbox and click the link to confirm. (If it isn\\u2019t there in a minute, look in spam.)");
            } else if (res.status === 409) {
              show("ok", "You\\u2019re already set \\u2014 I\\u2019ll email you when it\\u2019s out.");
            } else {
              show("err", data.error || "Something went wrong. Please try again in a moment.");
            }
          } catch (err) {
            show("err", "Couldn\\u2019t reach the server. Please try again in a moment.");
          } finally {
            btn.disabled = false;
            if (window.turnstile && widgetId !== undefined) window.turnstile.reset(widgetId);
          }
        });
      })();
      </script>`;
}

// ---- admin ----

async function renderAdmin(env, { notice = "", error = "", book: openSlug = "", subject = "", body = "" } = {}) {
  const { results: counts } = await env.DB
    .prepare("SELECT book_slug, SUM(confirmed_at IS NOT NULL) AS confirmed, SUM(confirmed_at IS NULL) AS waiting FROM book_alerts GROUP BY book_slug")
    .all();
  const { results: history } = await env.DB
    .prepare("SELECT book_slug, subject, sent_at, recipient_count FROM book_alert_sends ORDER BY sent_at DESC LIMIT 20")
    .all();
  const byBook = new Map(counts.map((c) => [c.book_slug, c]));

  const sections = BOOKS.filter((b) => byBook.has(b.slug) || !b.amazon)
    .map((b) => {
      const c = byBook.get(b.slug) || { confirmed: 0, waiting: 0 };
      const n = Number(c.confirmed) || 0;
      const people = `${n} ${n === 1 ? "person" : "people"}`;
      const status = b.amazon
        ? "Released: its Amazon link is set, so you can send the email."
        : "Not released yet. Give it its Amazon link in src/lib/books.js and deploy before sending.";
      const draft = openSlug === b.slug ? { subject, body } : defaultRelease(b);
      const form = n
        ? `<form method="POST" action="/admin/book-alerts/send" class="admin-form">
            <input type="hidden" name="book" value="${b.slug}" />
            <label for="subject-${b.slug}">Subject</label>
            <input type="text" id="subject-${b.slug}" name="subject" value="${escapeHtml(draft.subject)}" required />
            <label for="body-${b.slug}">Body (HTML)</label>
            <textarea id="body-${b.slug}" name="body" required>${escapeHtml(draft.body)}</textarea>
            <span class="field-hint">The footer, with each person&rsquo;s cancel link, is added automatically. After it&rsquo;s sent, these alerts are cleared.</span>
            <div class="row-actions" style="flex-wrap: wrap;">
              <button type="submit" name="mode" value="test" class="btn btn-ghost">Send me a test</button>
              <button type="submit" name="mode" value="all" class="btn btn-primary"${b.amazon ? "" : " disabled"}
                onclick="return confirm('Send this to ${people} waiting for ${escapeHtml(b.title).replace(/'/g, "\\'")}?');">Send to ${people}</button>
            </div>
          </form>`
        : "";
      return `<h2>${escapeHtml(b.title)}</h2>
        <p class="meta">${n} confirmed &middot; ${Number(c.waiting) || 0} waiting to confirm &middot; ${status}</p>${form}`;
    })
    .join("");

  const historyRows = history.length
    ? `<ul class="post-admin-list">${history
        .map((h) => `<li><div><strong>${escapeHtml(h.subject)}</strong><div class="meta">${formatDate(h.sent_at)} &middot; ${h.recipient_count} ${h.recipient_count === 1 ? "person" : "people"}</div></div></li>`)
        .join("")}</ul>`
    : `<p class="empty">Nothing sent yet.</p>`;

  return html(
    pageShell({
      title: "Admin — Book alerts",
      noindex: true,
      signOut: "/admin/book-alerts",
      bodyHtml: `
    <p class="eyebrow">Admin</p>
    <h1>Book alerts</h1>
    <p><a href="/admin/blog">Blog posts</a> &middot; <a href="/admin/newsletter">Newsletter</a></p>
    <p>People who asked, on a book&rsquo;s page, for one email when it comes out. They&rsquo;re not newsletter subscribers.</p>
    ${error ? `<p class="error-msg">${escapeHtml(error)}</p>` : ""}
    ${notice ? `<p class="notice-msg">${escapeHtml(notice)}</p>` : ""}
    ${sections || `<p class="empty">Every book is out, and nobody is waiting.</p>`}
    <h2>Sent</h2>
    ${historyRows}`,
    }),
    error ? 400 : 200
  );
}

async function handleSend(request, env) {
  const form = await request.formData();
  const book = bookBySlug((form.get("book") || "").toString());
  const subject = (form.get("subject") || "").toString().trim();
  const body = (form.get("body") || "").toString().trim();
  const mode = (form.get("mode") || "").toString();
  const fail = (msg) => renderAdmin(env, { error: msg, book: book ? book.slug : "", subject, body });

  if (!book) return fail("Unknown book.");
  if (!subject || !body) return fail("A subject and a body are both needed.");
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return fail("RESEND_API_KEY and FROM_EMAIL must be set to send email.");

  if (mode === "test") {
    if (!env.NOTIFY_EMAIL) return fail("Set NOTIFY_EMAIL to receive test sends.");
    try {
      await resendPost(env, "/emails", await releaseMessage(env, env.NOTIFY_EMAIL, book, "[Test] " + subject, body));
    } catch (e) {
      return fail("Test send failed: " + e.message);
    }
    return renderAdmin(env, { notice: `Test sent to ${env.NOTIFY_EMAIL}.`, book: book.slug, subject, body });
  }
  if (mode !== "all") return fail("Unknown send mode.");
  if (!book.amazon) return fail(`${book.title} has no Amazon link yet. Add it in src/lib/books.js and deploy first, so the email's link leads somewhere to buy it.`);

  const recent = await env.DB
    .prepare("SELECT sent_at FROM book_alert_sends WHERE book_slug = ? AND sent_at > ?")
    .bind(book.slug, new Date(Date.now() - 60 * 60 * 1000).toISOString())
    .first();
  if (recent) return fail("This book's alert went out in the last hour.");

  const { results } = await env.DB
    .prepare("SELECT email FROM book_alerts WHERE book_slug = ? AND confirmed_at IS NOT NULL ORDER BY confirmed_at")
    .bind(book.slug)
    .all();
  if (!results.length) return fail("Nobody has confirmed an alert for this book.");

  let sent = 0;
  let error = null;
  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const chunk = results.slice(i, i + BATCH_SIZE).map((r) => r.email);
    try {
      await resendPost(env, "/emails/batch", await Promise.all(chunk.map((e) => releaseMessage(env, e, book, subject, body))));
      // The promise was one email: clear each alert as soon as it's sent.
      await env.DB.batch(chunk.map((e) => env.DB.prepare("DELETE FROM book_alerts WHERE email = ? AND book_slug = ?").bind(e, book.slug)));
      sent += chunk.length;
    } catch (e) {
      error = e.message;
      break;
    }
  }
  if (sent) {
    await env.DB
      .prepare("INSERT INTO book_alert_sends (id, book_slug, subject, sent_at, recipient_count) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), book.slug, subject, new Date().toISOString(), sent)
      .run();
  }
  if (error) {
    return fail(`Sending stopped after ${sent} of ${results.length}: ${error}. Those ${sent} are cleared; sending again reaches only the rest.`);
  }
  return redirect(`/admin/book-alerts?sent=${sent}`);
}

export async function handleBookAlertRequest(request, env, url) {
  const path = url.pathname;
  if (path === "/api/book-alert" && request.method === "POST") return handleSignup(request, env);
  if (path === "/api/book-alert/confirm" && (request.method === "GET" || request.method === "POST")) return handleConfirm(request, env, url);
  if (path === "/api/book-alert/stop" && (request.method === "GET" || request.method === "POST")) return handleStop(request, env, url);

  if (path !== "/admin/book-alerts" && !path.startsWith("/admin/book-alerts/")) return null;
  if (!(await requireSession(request, ADMIN_AREA, env.SESSION_SECRET))) {
    if (request.method !== "GET") return redirect("/admin/book-alerts");
    return html(
      pageShell({
        title: "Admin — Book alerts",
        noindex: true,
        bodyHtml: loginFormHtml({ heading: "Admin — Book alerts", action: "/admin/blog/login", next: "/admin/book-alerts" }),
      })
    );
  }
  if ((path === "/admin/book-alerts" || path === "/admin/book-alerts/") && request.method === "GET") {
    const sent = url.searchParams.get("sent");
    return renderAdmin(env, sent ? { notice: `Sent to ${sent} ${sent === "1" ? "person" : "people"}.` } : {});
  }
  if (path === "/admin/book-alerts/send" && request.method === "POST") return handleSend(request, env);
  return null;
}
