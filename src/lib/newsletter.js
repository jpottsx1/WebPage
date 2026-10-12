/**
 * Newsletter: unsubscribe links + the subscriber admin / sender.
 *
 *   GET   /api/unsubscribe?email=…&token=…  — confirmation page with a button
 *   POST  /api/unsubscribe?email=…&token=…  — removes the subscriber. Used by
 *         that button and by mail clients' one-click unsubscribe (RFC 8058).
 *         GET never deletes, so link scanners that prefetch URLs in email
 *         (Outlook Safe Links etc.) can't unsubscribe people by accident.
 *
 *   GET   /admin/newsletter                  — subscribers, compose, history
 *   GET   /admin/newsletter/subscribers.csv  — export
 *   POST  /admin/newsletter/remove           — remove one subscriber
 *   POST  /admin/newsletter/archive          — add an issue to, or take it out of, the archive
 *   POST  /admin/newsletter/preview          — the email as readers will see it (new tab)
 *   POST  /admin/newsletter/draft-delete     — delete a saved draft
 *   Drafts are saved with the composer's Save draft button (email_drafts).
 *
 *   GET   /newsletter                        — public archive of past issues
 *   GET   /newsletter/:id                    — one past issue
 *
 * Issues are only public if they're in newsletter_public: off by default,
 * because the newsletter carries early chapters meant for subscribers.
 *   POST  /admin/newsletter/send             — send a test or send to everyone
 *
 * The admin pages share the blog admin login (ADMIN_PASSWORD_BLOG).
 * Unsubscribe tokens are an HMAC of the address keyed by SESSION_SECRET, so
 * rotating SESSION_SECRET invalidates links in emails already sent.
 * MAILING_ADDRESS (optional var) is printed in every email's footer —
 * Canada's anti-spam law expects a mailing address in commercial email.
 */

import { escapeHtml, formatDate } from "./util.js";
import { excerpt, subscribeBoxHtml } from "./blog.js";
import { pageShell, notFoundPage } from "./layout.js";
import { requireSession, loginFormHtml } from "./auth.js";

const ADMIN_AREA = "admin-blog";
const SITE = "https://jeffreypotts.ca";
const BATCH_SIZE = 100; // Resend's batch endpoint limit

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...extraHeaders } });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location } });
}

// ---- unsubscribe tokens ----

async function unsubscribeToken(secret, email) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("unsubscribe:" + email));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function unsubscribeUrl(env, email) {
  if (!env.SESSION_SECRET) return null;
  const token = await unsubscribeToken(env.SESSION_SECRET, email);
  return `${SITE}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
}

/** Resend `headers` that make mail clients show their own Unsubscribe button. */
export function unsubscribeHeaders(url) {
  return url ? { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined;
}

/** Shared email footer: why you got this, how to leave, mailing address. */
export function emailFooterHtml(env, url) {
  const address = env.MAILING_ADDRESS ? `<br>${escapeHtml(env.MAILING_ADDRESS)}` : "";
  const leave = url
    ? `Don&rsquo;t want these any more? <a href="${escapeHtml(url)}" style="color:#6f6a5c;">Unsubscribe</a>.`
    : `To unsubscribe, just reply to this email.`;
  return `
    <hr style="border:none; border-top:1px solid #e3d6b8; margin:28px 0;">
    <p style="font-family:Arial,Helvetica,sans-serif; font-size:12px; color:#6f6a5c;">
      You&rsquo;re receiving this because you signed up at jeffreypotts.ca. ${leave}${address}
    </p>`;
}

async function handleUnsubscribe(request, env, url) {
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const token = url.searchParams.get("token") || "";
  const isPost = request.method === "POST";
  // A mail client's one-click POST never shows the response to anyone.
  const oneClick = isPost && !(request.headers.get("Accept") || "").includes("text/html");

  const page = (heading, body, status = 200) =>
    html(pageShell({ title: "Unsubscribe — Jeffrey Potts", noindex: true, bodyHtml: `<p class="eyebrow">Newsletter</p><h1>${heading}</h1>${body}` }), status);

  let valid = false;
  if (email && token && env.SESSION_SECRET) {
    valid = timingSafeEqual(await unsubscribeToken(env.SESSION_SECRET, email), token);
  }
  if (!valid) {
    if (oneClick) return new Response(null, { status: 400 });
    return page("That link isn&rsquo;t valid.", `<p>Double-check the link from the email, or <a href="/#contact">send me a note</a> and I&rsquo;ll remove you by hand.</p>`, 400);
  }

  if (!isPost) {
    return page(
      "Unsubscribe?",
      `<p>Stop sending the newsletter to <strong>${escapeHtml(email)}</strong>?</p>
      <form method="POST" action="${escapeHtml(url.pathname + url.search)}">
        <button type="submit" class="btn btn-primary">Unsubscribe</button>
      </form>`
    );
  }

  try {
    await env.DB.prepare("DELETE FROM subscribers WHERE email = ?").bind(email).run();
  } catch (e) {
    if (oneClick) return new Response(null, { status: 500 });
    return page("Something went wrong.", `<p>Please try again, or <a href="/#contact">send me a note</a> and I&rsquo;ll remove you by hand.</p>`, 500);
  }

  if (oneClick) return new Response(null, { status: 200 });
  return page("You&rsquo;re off the list.", `<p>${escapeHtml(email)} won&rsquo;t get the newsletter any more. Thanks for reading.</p>`);
}

// ---- sending ----

function newsletterHtml(env, bodyHtml, firstName, url) {
  const body = bodyHtml.replace(/\{\{\s*name\s*\}\}/g, escapeHtml(firstName));
  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; color:#2a2622; max-width:560px; margin:0 auto; line-height:1.6;">
    ${body}
    ${emailFooterHtml(env, url)}
  </div>`;
}

async function buildMessage(env, sub, subject, bodyHtml) {
  const url = await unsubscribeUrl(env, sub.email);
  const headers = unsubscribeHeaders(url);
  return {
    from: env.FROM_EMAIL,
    to: [sub.email],
    subject,
    html: newsletterHtml(env, bodyHtml, (sub.name || "").split(/\s+/)[0] || "friend", url),
    ...(headers ? { headers } : {}),
  };
}

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

async function handleSend(request, env) {
  const form = await request.formData();
  const subject = (form.get("subject") || "").toString().trim();
  const body = (form.get("body") || "").toString().trim();
  const mode = (form.get("mode") || "").toString();
  let draftId = (form.get("draft_id") || "").toString();

  const fail = (msg) => renderAdmin(env, { error: msg, subject, body, draftId });

  if (mode === "save") {
    if (!subject && !body) return fail("There's nothing to save yet.");
    draftId = await saveDraft(env, draftId, subject, body);
    return renderAdmin(env, { notice: "Draft saved.", subject, body, draftId });
  }

  if (!subject || !body) return fail("A subject and a body are both needed.");
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return fail("RESEND_API_KEY and FROM_EMAIL must be set to send email.");

  if (mode === "test") {
    if (!env.NOTIFY_EMAIL) return fail("Set NOTIFY_EMAIL to receive test sends.");
    try {
      const msg = await buildMessage(env, { email: env.NOTIFY_EMAIL, name: "Jeffrey" }, "[Test] " + subject, body);
      await resendPost(env, "/emails", msg);
    } catch (e) {
      return fail("Test send failed: " + e.message);
    }
    return renderAdmin(env, { notice: `Test sent to ${env.NOTIFY_EMAIL}.`, subject, body, draftId });
  }

  if (mode !== "all") return fail("Unknown send mode.");

  // Guard against a double-click or a resubmitted form sending twice.
  const recent = await env.DB
    .prepare("SELECT sent_at FROM newsletters WHERE subject = ? AND sent_at > ?")
    .bind(subject, new Date(Date.now() - 60 * 60 * 1000).toISOString())
    .first();
  if (recent) return fail("A newsletter with this subject went out in the last hour. Change the subject if you really mean to send it again.");

  const { results: subs } = await env.DB.prepare("SELECT email, name FROM subscribers ORDER BY created_at").all();
  if (!subs.length) return fail("There are no subscribers yet.");

  let sent = 0;
  let error = null;
  for (let i = 0; i < subs.length; i += BATCH_SIZE) {
    const batch = await Promise.all(subs.slice(i, i + BATCH_SIZE).map((s) => buildMessage(env, s, subject, body)));
    try {
      await resendPost(env, "/emails/batch", batch);
      sent += batch.length;
    } catch (e) {
      error = e.message;
      break;
    }
  }

  if (sent) {
    const id = crypto.randomUUID();
    await env.DB
      .prepare("INSERT INTO newsletters (id, subject, body_html, sent_at, recipient_count) VALUES (?, ?, ?, ?, ?)")
      .bind(id, subject, body, new Date().toISOString(), sent)
      .run();
    if (form.get("archive")) await setArchived(env, id, true);
    if (draftId) await deleteDraft(env, draftId);
  }
  if (error) {
    return fail(`Sending stopped after ${sent} of ${subs.length} subscribers: ${error}. The first ${sent} got it; don't resend to everyone.`);
  }
  return redirect(`/admin/newsletter?sent=${sent}`);
}

// ---- drafts and preview ----

async function saveDraft(env, id, subject, body) {
  const draftId = id || crypto.randomUUID();
  await env.DB
    .prepare(
      "INSERT INTO email_drafts (id, subject, body_html, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, body_html = excluded.body_html, updated_at = excluded.updated_at"
    )
    .bind(draftId, subject, body, new Date().toISOString())
    .run();
  return draftId;
}

async function deleteDraft(env, id) {
  await env.DB.prepare("DELETE FROM email_drafts WHERE id = ?").bind(id).run();
}

// The email exactly as it's sent, with "Reader" for {{name}} and a sample
// unsubscribe link, inside a frame that says it's a preview.
async function renderPreview(request, env) {
  const form = await request.formData();
  const subject = (form.get("subject") || "").toString().trim() || "(no subject)";
  const body = (form.get("body") || "").toString();
  const email = newsletterHtml(env, body, "Reader", "https://jeffreypotts.ca/api/unsubscribe?preview");
  return html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" /><title>Preview: ${escapeHtml(subject)}</title>
<style>
  body { margin: 0; background: #e9e6df; font-family: 'Helvetica Neue', Arial, sans-serif; }
  .bar { background: #17343b; color: #ede3cf; padding: 12px 20px; font-size: 14px; }
  .bar strong { color: #fff; }
  .mail { background: #fff; max-width: 640px; margin: 24px auto; padding: 28px 32px; box-shadow: 0 2px 10px rgba(0,0,0,0.12); }
  .meta { max-width: 640px; margin: 24px auto 0; font-size: 14px; color: #444; }
</style></head><body>
<div class="bar">Preview &mdash; not sent. <strong>{{name}}</strong> shows as &ldquo;Reader&rdquo;; each subscriber sees their own name and unsubscribe link.</div>
<div class="meta"><strong>From:</strong> ${escapeHtml(env.FROM_EMAIL || "")}<br><strong>Subject:</strong> ${escapeHtml(subject)}</div>
<div class="mail">${email}</div>
</body></html>`);
}

// ---- the public archive ----

async function setArchived(env, id, archived) {
  if (archived) {
    await env.DB.prepare("INSERT OR IGNORE INTO newsletter_public (newsletter_id) VALUES (?)").bind(id).run();
  } else {
    await env.DB.prepare("DELETE FROM newsletter_public WHERE newsletter_id = ?").bind(id).run();
  }
}

// What a reader of the archive sees in place of {{name}}.
function archiveBody(bodyHtml) {
  return bodyHtml.replace(/\{\{\s*name\s*\}\}/g, "friend");
}

async function renderArchive(env) {
  const { results } = await env.DB
    .prepare("SELECT n.id, n.subject, n.body_html, n.sent_at FROM newsletters n JOIN newsletter_public p ON p.newsletter_id = n.id ORDER BY n.sent_at DESC")
    .all();
  const list = results.length
    ? `<ul class="post-list">${results
        .map(
          (n) => `
    <li>
      <a href="/newsletter/${n.id}">${escapeHtml(n.subject)}</a>
      <span class="post-date">${formatDate(n.sent_at)}</span>
      <p class="post-excerpt">${escapeHtml(excerpt(archiveBody(n.body_html)))}</p>
    </li>`
        )
        .join("")}</ul>`
    : `<p class="empty">No past issues are in the archive yet.</p>`;
  return html(
    pageShell({
      title: "Newsletter archive — Jeffrey Potts",
      description: "Past issues of Jeffrey Potts's newsletter: news, writing and the stories behind the books.",
      canonical: "/newsletter",
      bodyHtml: `
      <p class="eyebrow">Newsletter</p>
      <h1>Past issues</h1>
      <p>Some of what goes out to subscribers. Early chapters stay with the people on the list &mdash; <a href="/#signup">sign up</a> to get those too.</p>
      ${list}
      ${subscribeBoxHtml()}`,
    })
  );
}

async function renderIssue(env, id) {
  const n = await env.DB
    .prepare("SELECT n.id, n.subject, n.body_html, n.sent_at FROM newsletters n JOIN newsletter_public p ON p.newsletter_id = n.id WHERE n.id = ?")
    .bind(id)
    .first();
  if (!n) return notFoundPage();
  const body = archiveBody(n.body_html);
  return html(
    pageShell({
      title: `${n.subject} — Jeffrey Potts's newsletter`,
      description: excerpt(body, 160),
      canonical: `/newsletter/${n.id}`,
      ogType: "article",
      bodyHtml: `
      <p class="eyebrow">Newsletter &middot; ${formatDate(n.sent_at)}</p>
      <h1>${escapeHtml(n.subject)}</h1>
      <div class="post-body">${body}</div>
      ${subscribeBoxHtml()}
      <p style="margin-top:40px;"><a href="/newsletter">&larr; All past issues</a></p>`,
    })
  );
}

// ---- admin pages ----

function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running it as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function renderAdmin(env, { notice = "", error = "", subject = "", body = "", draftId = "" } = {}) {
  const { results: drafts } = await env.DB.prepare("SELECT id, subject, updated_at FROM email_drafts ORDER BY updated_at DESC").all();
  const { results: subs } = await env.DB.prepare("SELECT email, name, created_at FROM subscribers ORDER BY created_at DESC").all();
  const { results: history } = await env.DB
    .prepare(
      "SELECT n.id, n.subject, n.sent_at, n.recipient_count, p.newsletter_id IS NOT NULL AS archived FROM newsletters n LEFT JOIN newsletter_public p ON p.newsletter_id = n.id ORDER BY n.sent_at DESC LIMIT 20"
    )
    .all();

  const warnings = [];
  if (!env.MAILING_ADDRESS) warnings.push("MAILING_ADDRESS isn't set. Canada's anti-spam law (CASL) expects a mailing address in the footer of newsletter emails; add it as a variable on the Worker.");
  if (!env.SESSION_SECRET) warnings.push("SESSION_SECRET isn't set, so emails can't include unsubscribe links.");

  const subRows = subs.length
    ? `<ul class="post-admin-list">${subs
        .map(
          (s) => `
      <li>
        <div>
          <strong>${escapeHtml(s.name)}</strong>
          <div class="meta">${escapeHtml(s.email)} &middot; joined ${formatDate(s.created_at)}</div>
        </div>
        <div class="row-actions">
          <form method="POST" action="/admin/newsletter/remove" onsubmit="return confirm('Remove ${escapeHtml(s.email).replace(/'/g, "\\'")} from the list?');">
            <input type="hidden" name="email" value="${escapeHtml(s.email)}" />
            <button type="submit" class="btn btn-danger">Remove</button>
          </form>
        </div>
      </li>`
        )
        .join("")}</ul>`
    : `<p class="empty">No subscribers yet.</p>`;

  const historyRows = history.length
    ? `<ul class="post-admin-list">${history
        .map(
          (h) => `<li><div><strong>${escapeHtml(h.subject)}</strong><div class="meta">${formatDate(h.sent_at)} &middot; ${h.recipient_count} recipient${h.recipient_count === 1 ? "" : "s"} &middot; ${
            h.archived ? `in the <a href="/newsletter/${h.id}">public archive</a>` : "not in the archive"
          }</div></div>
          <div class="row-actions"><form method="POST" action="/admin/newsletter/archive">
            <input type="hidden" name="id" value="${escapeHtml(h.id)}" /><input type="hidden" name="archived" value="${h.archived ? "0" : "1"}" />
            <button type="submit" class="btn btn-ghost">${h.archived ? "Remove from archive" : "Add to archive"}</button>
          </form></div></li>`
        )
        .join("")}</ul>`
    : `<p class="empty">Nothing sent yet.</p>`;

  const count = subs.length;
  const bodyHtml = `
    <p class="eyebrow">Admin</p>
    <h1>Newsletter</h1>
    <p><a href="/admin/blog">Blog posts</a> &middot; <a href="/admin/newsletter/subscribers.csv">Export subscribers (CSV)</a></p>
    ${warnings.map((w) => `<p class="error-msg">${escapeHtml(w)}</p>`).join("")}
    ${error ? `<p class="error-msg">${escapeHtml(error)}</p>` : ""}
    ${notice ? `<p class="notice-msg">${escapeHtml(notice)}</p>` : ""}

    <h2>${draftId ? "Editing a draft" : "Write a newsletter"}</h2>
    <form method="POST" action="/admin/newsletter/send" class="admin-form" id="composer">
      <input type="hidden" name="draft_id" value="${escapeHtml(draftId)}" />
      <label for="subject">Subject</label>
      <input type="text" id="subject" name="subject" value="${escapeHtml(subject)}" required />
      <label for="body">Body (HTML)</label>
      <textarea id="body" name="body" required>${escapeHtml(body)}</textarea>
      <span class="field-hint">Write <code>{{name}}</code> to insert each reader&rsquo;s first name. The unsubscribe footer is added automatically.</span>
      <label class="checkbox"><input type="checkbox" name="archive" value="1" /> Add to the public archive at <a href="/newsletter">/newsletter</a></label>
      <span class="field-hint">Leave this off for issues that carry subscriber-only early chapters. You can change it later under Sent.</span>
      <div class="row-actions" style="flex-wrap: wrap;">
        <button type="submit" name="mode" value="save" class="btn btn-ghost">Save draft</button>
        <button type="submit" formaction="/admin/newsletter/preview" formtarget="_blank" class="btn btn-ghost">Preview</button>
        <button type="submit" name="mode" value="test" class="btn btn-ghost">Send me a test</button>
        <button type="submit" name="mode" value="all" class="btn btn-primary"
          onclick="return confirm('Send this to all ${count} subscriber${count === 1 ? "" : "s"}?');">Send to ${count} subscriber${count === 1 ? "" : "s"}</button>
      </div>
    </form>

    ${draftId ? `<p><a href="/admin/newsletter">Start a new newsletter instead</a></p>` : ""}

    <h2>Drafts</h2>
    ${drafts.length
      ? `<ul class="post-admin-list">${drafts
          .map(
            (d) => `<li><div><strong>${escapeHtml(d.subject || "(no subject)")}</strong><div class="meta">saved ${formatDate(d.updated_at)}${d.id === draftId ? " &middot; open above" : ""}</div></div>
          <div class="row-actions"><a class="btn btn-ghost" href="/admin/newsletter?draft=${d.id}">Edit</a>
            <form method="POST" action="/admin/newsletter/draft-delete" onsubmit="return confirm('Delete this draft?');"><input type="hidden" name="id" value="${escapeHtml(d.id)}" /><button type="submit" class="btn btn-danger">Delete</button></form></div></li>`
          )
          .join("")}</ul>`
      : `<p class="empty">No saved drafts.</p>`}

    <h2>Sent</h2>
    ${historyRows}

    <h2>Subscribers (${count})</h2>
    ${subRows}
    <script>
    (function () {
      // Warn before leaving with unsaved changes in the composer.
      var form = document.getElementById("composer");
      var start = new FormData(form);
      var dirty = function () {
        var now = new FormData(form);
        return now.get("subject") !== start.get("subject") || now.get("body") !== start.get("body");
      };
      var leaving = false;
      form.addEventListener("submit", function (e) { if (!e.submitter || e.submitter.formTarget !== "_blank") leaving = true; });
      window.addEventListener("beforeunload", function (e) { if (!leaving && dirty()) { e.preventDefault(); e.returnValue = ""; } });
    })();
    </script>
  `;
  return html(pageShell({ title: "Admin — Newsletter", noindex: true, signOut: "/admin/newsletter", bodyHtml }), error ? 400 : 200);
}

export async function handleNewsletterRequest(request, env, url) {
  const path = url.pathname;

  if (path === "/api/unsubscribe" && (request.method === "GET" || request.method === "POST")) {
    return handleUnsubscribe(request, env, url);
  }

  if ((path === "/newsletter" || path === "/newsletter/") && request.method === "GET") {
    return renderArchive(env);
  }
  const issue = path.match(/^\/newsletter\/([a-f0-9-]{36})\/?$/);
  if (issue && request.method === "GET") {
    return renderIssue(env, issue[1]);
  }

  if (path !== "/admin/newsletter" && !path.startsWith("/admin/newsletter/")) return null;

  const authed = await requireSession(request, ADMIN_AREA, env.SESSION_SECRET);
  if (!authed) {
    if (request.method !== "GET") return redirect("/admin/newsletter");
    return html(
      pageShell({
        title: "Admin — Newsletter",
        noindex: true,
        bodyHtml: loginFormHtml({ heading: "Admin — Newsletter", action: "/admin/blog/login", next: "/admin/newsletter" }),
      })
    );
  }

  if ((path === "/admin/newsletter" || path === "/admin/newsletter/") && request.method === "GET") {
    const sent = url.searchParams.get("sent");
    const draftParam = url.searchParams.get("draft");
    if (draftParam) {
      const d = await env.DB.prepare("SELECT id, subject, body_html FROM email_drafts WHERE id = ?").bind(draftParam).first();
      if (d) return renderAdmin(env, { subject: d.subject, body: d.body_html, draftId: d.id });
    }
    return renderAdmin(env, sent ? { notice: `Sent to ${sent} subscriber${sent === "1" ? "" : "s"}.` } : {});
  }

  if (path === "/admin/newsletter/subscribers.csv" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT name, email, created_at FROM subscribers ORDER BY created_at").all();
    const csv = ["name,email,joined", ...results.map((r) => [r.name, r.email, r.created_at].map(csvCell).join(","))].join("\r\n");
    return new Response(csv + "\r\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="subscribers-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (path === "/admin/newsletter/preview" && request.method === "POST") {
    return renderPreview(request, env);
  }

  if (path === "/admin/newsletter/draft-delete" && request.method === "POST") {
    const form = await request.formData();
    const id = (form.get("id") || "").toString();
    if (id) await deleteDraft(env, id);
    return redirect("/admin/newsletter");
  }

  if (path === "/admin/newsletter/archive" && request.method === "POST") {
    const form = await request.formData();
    const id = (form.get("id") || "").toString();
    if (id) await setArchived(env, id, form.get("archived") === "1");
    return redirect("/admin/newsletter");
  }

  if (path === "/admin/newsletter/remove" && request.method === "POST") {
    const form = await request.formData();
    const email = (form.get("email") || "").toString().trim().toLowerCase();
    if (email) await env.DB.prepare("DELETE FROM subscribers WHERE email = ?").bind(email).run();
    return redirect("/admin/newsletter");
  }

  if (path === "/admin/newsletter/send" && request.method === "POST") {
    return handleSend(request, env);
  }

  return null;
}
