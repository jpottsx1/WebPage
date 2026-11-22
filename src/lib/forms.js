/**
 * The printable forms from When Your Mind and Money Collide, behind a name
 * and email sign-up.
 *
 *   GET  /forms               — the list; a sign-up form until you've signed up
 *   POST /api/forms-access    — name + email (+ optional newsletter); sets the
 *                               access cookie and records the sign-up
 *   GET  /forms/<file>.pdf    — the PDF with the access cookie; without it,
 *                               back to /forms with that form picked out
 *
 * The book sends readers to jeffreypotts.ca/Forms, so /Forms (any
 * capitalisation, with or without a slash) redirects to /forms.
 *
 * The forms unlock as soon as someone signs up: no email round trip for a
 * reader who may be in crisis. The newsletter is a separate, unticked box
 * (CASL wants that consent asked for on its own); ticking it starts the usual
 * double opt-in, and only then does the form need Turnstile, since that's the
 * path that sends email. Sign-ups are kept in forms_signups (schema.sql).
 *
 * The list lives in src/data/forms.json; the PDFs in /forms are cut from the
 * book's print interior by tools/build-forms.py. wrangler.jsonc runs this
 * Worker first for /forms/*, so the PDFs are never served without the cookie.
 */

import { escapeHtml } from "./util.js";
import { pageShell } from "./layout.js";
import { BOOKS } from "./books.js";
import { sign, sameString } from "./optin.js";
import { formLimited, FORM_LIMITED_MESSAGE } from "./ratelimit.js";
import { verifyTurnstile, TURNSTILE_SITEKEY, TURNSTILE_FAILED_MESSAGE } from "./turnstile.js";
import FORMS from "../data/forms.json";

const COOKIE = "jp_forms";
const COOKIE_DAYS = 365;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const byFile = new Map(FORMS.forms.map((f) => [f.file, f]));
const ALL = { title: "Every form (one PDF)", file: FORMS.all };

const STYLE = `<style>
  .forms-intro { max-width: 42em; }
  .forms-all { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; margin: 20px 0 8px; }
  .forms-toc { columns: 2 260px; column-gap: 32px; padding-left: 1.2em; margin: 24px 0 36px; }
  .forms-toc li { break-inside: avoid; margin-bottom: 4px; }
  .forms-chapter { margin: 0 0 32px; scroll-margin-top: 16px; }
  .forms-chapter h2 { font-size: 1.15rem; margin: 0 0 10px; }
  .forms-list { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--line); }
  .forms-list li { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--line); }
  .forms-list a { font-weight: 600; }
  .forms-list .meta { color: var(--muted); font-size: 0.9rem; white-space: nowrap; }
  .forms-locked .forms-list a { font-weight: 400; color: var(--ink); text-decoration: none; }
  .forms-locked .forms-list a::before { content: "🔒 "; font-size: 0.8em; }
  .forms-help { background: var(--surface); border-left: 3px solid var(--gold); padding: 16px 20px; margin: 8px 0 36px; }
  .forms-help p { margin: 0; }
  .forms-get { border-top: 3px solid var(--rust); background: var(--surface); padding: 22px 24px; margin: 24px 0 32px; max-width: 40em; scroll-margin-top: 16px; }
  .forms-get h2 { margin: 0 0 6px; font-size: 1.25rem; }
  .forms-get p { margin: 0 0 14px; }
  .fg-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  .fg-fields label, .fg-check { display: block; font: 700 0.85rem/1.4 'Helvetica Neue', Arial, sans-serif; margin-bottom: 6px; }
  .fg-fields input { width: 100%; padding: 10px 12px; font-size: 1rem; border: 1px solid var(--line); background: var(--input-bg); color: var(--ink); }
  .fg-check { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; margin: 4px 0 14px; }
  .fg-check input { margin-top: 4px; }
  .fg-hp { position: absolute; left: -9999px; }
  .forms-get .turnstile-slot { margin: 0 0 12px; }
  .fg-msg { margin: 12px 0 0; font-weight: 600; }
  .fg-msg[data-state="err"] { color: var(--rust-text); }
  .fg-fine { font-size: 0.85rem; color: var(--muted); margin: 14px 0 0 !important; }
  .forms-ready { border-top: 3px solid var(--teal); background: var(--surface); padding: 18px 22px; margin: 24px 0 32px; }
  .forms-ready p { margin: 0 0 10px; }
  .forms-ready p:last-child { margin: 0; }
  @media (max-width: 560px) { .forms-list li { flex-direction: column; gap: 2px; } .fg-fields { grid-template-columns: 1fr; } }
</style>`;

const slugify = (s) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pageCount = (f) => f.sourcePages.length;
const totalPages = FORMS.forms.reduce((n, f) => n + pageCount(f), 0);

function chapters() {
  const out = [];
  for (const f of FORMS.forms) {
    if (!out.length || out[out.length - 1].name !== f.chapter) out.push({ name: f.chapter, id: slugify(f.chapter), forms: [] });
    out[out.length - 1].forms.push(f);
  }
  return out;
}

/** A form (or the all-forms PDF) by its /forms/... path, or null. */
function formByFile(file) {
  if (file === FORMS.all) return ALL;
  return byFile.get(file) || null;
}

// ---- access cookie: "<time>.<hmac of forms:<time>>" ----

async function hasAccess(request, env) {
  if (!env.SESSION_SECRET) return false;
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([a-f0-9]+)`));
  if (!m) return false;
  const t = Number(m[1]);
  if (!Number.isFinite(t) || Date.now() - t > COOKIE_DAYS * 864e5) return false;
  return sameString(await sign(env.SESSION_SECRET, `forms:${t}`), m[2]);
}

async function accessCookie(env) {
  const t = Date.now();
  const value = `${t}.${await sign(env.SESSION_SECRET, `forms:${t}`)}`;
  return `${COOKIE}=${value}; Path=/forms; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

// ---- the page ----

function getFormHtml(wanted) {
  return `<section class="forms-get" id="get" aria-labelledby="get-h">
      <h2 id="get-h">${wanted ? `Get &ldquo;${escapeHtml(wanted.title)}&rdquo;` : "Get the forms"}</h2>
      <p>Enter your name and email and every form unlocks straight away, on this device. ${wanted ? "Your download starts right after." : ""}</p>
      <form id="fg-form" method="POST" action="/api/forms-access" novalidate>
        <input type="hidden" name="form" value="${wanted ? escapeHtml(wanted.file) : ""}" />
        <div class="fg-fields">
          <div><label for="fg-name">Your name</label><input type="text" id="fg-name" name="name" autocomplete="name" maxlength="120" required /></div>
          <div><label for="fg-email">Email address</label><input type="email" id="fg-email" name="email" autocomplete="email" maxlength="254" required /></div>
        </div>
        <div class="fg-hp" aria-hidden="true"><label for="fg-website">Leave this empty</label><input type="text" id="fg-website" name="website" tabindex="-1" autocomplete="off" /></div>
        <label class="fg-check"><input type="checkbox" id="fg-news" name="newsletter" value="1" /> <span>Also send me Jeffrey&rsquo;s newsletter: new writing and the occasional update. Optional; I&rsquo;ll email you a link to confirm.</span></label>
        <div id="fg-turnstile" class="turnstile-slot" hidden></div>
        <button type="submit" class="btn btn-primary">Unlock the forms</button>
        <p id="fg-msg" class="fg-msg" role="status" aria-live="polite"></p>
        <p class="fg-fine">Your email is used to keep track of who has the forms and, only if you tick the box, to send the newsletter. It&rsquo;s never sold or shared. <a href="/privacy">Privacy</a></p>
      </form>
    </section>
    <script>
    (function () {
      var form = document.getElementById("fg-form");
      var msg = document.getElementById("fg-msg");
      var btn = form.querySelector("button[type=submit]");
      var news = document.getElementById("fg-news");
      var slot = document.getElementById("fg-turnstile");
      var widgetId, loading = false;
      function show(state, text) { msg.dataset.state = state; msg.textContent = text; }
      // Turnstile only matters for the newsletter, so load it only when that box is ticked.
      window.onFormsTurnstileLoad = function () {
        widgetId = window.turnstile.render("#fg-turnstile", { sitekey: "${TURNSTILE_SITEKEY}", action: "forms" });
      };
      news.addEventListener("change", function () {
        slot.hidden = !news.checked;
        if (!news.checked || loading) return;
        loading = true;
        var s = document.createElement("script");
        s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onFormsTurnstileLoad&render=explicit";
        s.async = true;
        document.head.appendChild(s);
      });
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        var data = Object.fromEntries(new FormData(form).entries());
        if (!data.name.trim()) return show("err", "Please add your name.");
        if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(data.email.trim())) return show("err", "That email doesn\\u2019t look right. Mind checking it?");
        if (news.checked) {
          data["cf-turnstile-response"] = window.turnstile && widgetId !== undefined ? window.turnstile.getResponse(widgetId) : "";
          if (!data["cf-turnstile-response"]) return show("err", "Please complete the \\u201cVerify you are human\\u201d check above the button (it\\u2019s there for the newsletter), then try again.");
        }
        btn.disabled = true;
        show("", "");
        try {
          var res = await fetch("/api/forms-access", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(data) });
          var out = await res.json().catch(function () { return {}; });
          if (res.ok) { window.location.href = out.next; return; }
          show("err", out.error || "Something went wrong. Please try again in a moment.");
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

function readyHtml(wanted, newsletter) {
  const note = {
    pending: "<p>Check your inbox for a link to confirm the newsletter. (If it isn&rsquo;t there in a minute, look in spam.)</p>",
    already: "<p>You&rsquo;re already on the newsletter list, so there&rsquo;s nothing more to do there.</p>",
    failed: "<p>The newsletter confirmation email didn&rsquo;t send. You can sign up at the bottom of any blog post.</p>",
  }[newsletter] || "";
  return `<section class="forms-ready" aria-live="polite">
      <p><strong>Thanks. The forms are unlocked on this device.</strong></p>
      ${wanted ? `<p><a class="btn btn-primary" id="fg-ready" href="${escapeHtml(wanted.file)}" download>Download &ldquo;${escapeHtml(wanted.title)}&rdquo;</a></p>
      <script>setTimeout(function () { document.getElementById("fg-ready").click(); }, 400);</script>` : ""}
      ${note}
    </section>`;
}

async function formsPage(request, env, url) {
  const unlocked = await hasAccess(request, env);
  const book = BOOKS.find((b) => b.slug === FORMS.book);
  const wanted = formByFile(url.searchParams.get("form") || "");
  const justUnlocked = unlocked && url.searchParams.has("ok");
  // Locked links pick the form out on this page rather than pointing at a PDF
  // (a download attribute on a link that redirects would save this page).
  const link = (f) => (unlocked ? `href="${f.file}" download` : `href="/forms?form=${encodeURIComponent(f.file)}#get"`);

  const bodyHtml = `${STYLE}
    <p class="eyebrow"><a href="/books/${book.slug}">${escapeHtml(book.title)}</a></p>
    <h1>Printable forms and scripts</h1>
    <div class="forms-intro">
      <p>Every worksheet, letter, script and checklist from <a href="/books/${book.slug}"><em>${escapeHtml(book.fullTitle || book.title)}</em></a>, as a PDF you can print or fill in on your computer. Each one is listed under its chapter, with the page it&rsquo;s on in the book.</p>
      <p>${unlocked ? "Print a fresh copy whenever you need one." : "They&rsquo;re free. Enter your name and email once and they all unlock."}</p>
    </div>

    ${justUnlocked ? readyHtml(wanted, url.searchParams.get("nl")) : unlocked && wanted ? readyHtml(wanted, "") : ""}
    ${unlocked ? "" : getFormHtml(wanted)}

    <div class="forms-all">
      <a class="btn ${unlocked ? "btn-primary" : "btn-ghost"}" ${link(ALL)}>${unlocked ? "Download every form (one PDF)" : "Every form in one PDF"}</a>
      <span class="meta">${FORMS.forms.length} forms, ${totalPages} pages</span>
    </div>

    <div class="forms-help">
      <p><strong>In crisis right now?</strong> Call or text <a href="tel:988">988</a>, the Suicide Crisis Helpline, any time. In an emergency, call 911.</p>
    </div>

    <nav aria-label="Chapters">
      <ol class="forms-toc">${chapters().map((g) => `<li><a href="#${g.id}">${escapeHtml(g.name)}</a></li>`).join("")}</ol>
    </nav>

    <div class="${unlocked ? "" : "forms-locked"}">
    ${chapters()
      .map(
        (g) => `<section class="forms-chapter" id="${g.id}" aria-labelledby="${g.id}-h">
      <h2 id="${g.id}-h">${escapeHtml(g.name)}</h2>
      <ul class="forms-list">${g.forms
        .map((f) => `<li><a ${link(f)}>${escapeHtml(f.title)}</a><span class="meta">Page ${f.page} &middot; PDF${pageCount(f) > 1 ? `, ${pageCount(f)} pages` : ""}</span></li>`)
        .join("")}</ul>
    </section>`
      )
      .join("\n")}
    </div>

    <p>Don&rsquo;t have the book yet? <a href="/books/${book.slug}">Read about it</a> or <a href="${escapeHtml(book.amazon)}" target="_blank" rel="noopener">buy it on Amazon</a>.</p>`;

  return new Response(
    pageShell({
      title: "Printable Forms — When Your Mind and Money Collide",
      description: `Free printable PDFs of all ${FORMS.forms.length} forms, letters and scripts from When Your Mind and Money Collide: crisis budgets, creditor scripts, hardship letters, benefit organizers and more.`,
      canonical: "/forms",
      image: book.jpg,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: "Printable forms and scripts",
        url: "https://jeffreypotts.ca/forms",
        isPartOf: { "@type": "Book", name: book.fullTitle || book.title, url: `https://jeffreypotts.ca/books/${book.slug}` },
      },
      bodyHtml,
    }),
    // Depends on the cookie, so never shared from a cache.
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", Vary: "Cookie" } }
  );
}

// ---- POST /api/forms-access ----

async function handleAccess(request, env, startNewsletterOptIn) {
  const wantsJson = (request.headers.get("Accept") || "").includes("application/json");
  let data;
  try {
    data = (request.headers.get("Content-Type") || "").includes("application/json")
      ? await request.json()
      : Object.fromEntries((await request.formData()).entries());
  } catch (e) {
    data = {};
  }
  const fail = (status, error) =>
    wantsJson
      ? Response.json({ error }, { status })
      : new Response(pageShell({ title: "Forms — Jeffrey Potts", noindex: true, bodyHtml: `<h1>Not quite.</h1><p>${escapeHtml(error)}</p><p><a class="btn btn-primary" href="/forms#get">Back to the forms</a></p>` }), {
          status,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });

  const name = String(data.name || "").trim().replace(/\s+/g, " ");
  const email = String(data.email || "").trim().toLowerCase();
  const newsletter = Boolean(data.newsletter);
  const wanted = formByFile(String(data.form || ""));

  if (String(data.website || "")) return fail(400, "Something went wrong. Please try again."); // honeypot
  if (await formLimited(env, request, "forms")) return fail(429, FORM_LIMITED_MESSAGE);
  if (!name || name.length > 120) return fail(400, "Please add your name.");
  if (email.length > 254 || !EMAIL_RE.test(email)) return fail(400, "That email doesn't look right. Mind checking it?");
  if (newsletter && !(await verifyTurnstile(env, request, data["cf-turnstile-response"], "forms"))) {
    return fail(403, TURNSTILE_FAILED_MESSAGE);
  }
  if (!env.DB || !env.SESSION_SECRET) return fail(500, "The forms aren't set up yet. Please try again later.");

  const now = new Date().toISOString();
  try {
    await env.DB
      .prepare(
        `INSERT INTO forms_signups (email, name, newsletter, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(email) DO UPDATE SET name = excluded.name, newsletter = MAX(newsletter, excluded.newsletter), updated_at = excluded.updated_at`
      )
      .bind(email, name, newsletter ? 1 : 0, now)
      .run();
  } catch (e) {
    return fail(500, "We couldn't save that just now. Please try again in a minute.");
  }

  let nl = "";
  if (newsletter) {
    try {
      nl = await startNewsletterOptIn(env, email, name); // "pending" | "already"
    } catch (e) {
      nl = "failed";
    }
  }

  const params = new URLSearchParams({ ok: "1" });
  if (wanted) params.set("form", wanted.file);
  if (nl) params.set("nl", nl);
  const next = `/forms?${params}`;
  const cookie = await accessCookie(env);
  return wantsJson
    ? new Response(JSON.stringify({ ok: true, next }), { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": cookie } })
    : new Response(null, { status: 303, headers: { Location: next, "Set-Cookie": cookie } });
}

// ---- GET /forms/<file>.pdf ----

async function servePdf(request, env, url) {
  const f = formByFile(url.pathname);
  if (!f) return null; // not one of ours: the normal 404
  if (!(await hasAccess(request, env))) {
    return new Response(null, { status: 302, headers: { Location: `/forms?form=${encodeURIComponent(f.file)}#get`, "Cache-Control": "no-store" } });
  }
  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "private, max-age=604800");
  return out;
}

/**
 * startNewsletterOptIn(env, email, name) comes from the Worker, which owns
 * the newsletter's confirmation email; it returns "pending" or "already".
 */
export async function handleFormsRequest(request, env, url, { startNewsletterOptIn }) {
  if (url.pathname === "/api/forms-access") {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    return handleAccess(request, env, startNewsletterOptIn);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (url.pathname.startsWith("/forms/") && url.pathname.endsWith(".pdf")) return servePdf(request, env, url);
  const path = url.pathname.toLowerCase();
  if (path !== "/forms" && path !== "/forms/") return null;
  if (url.pathname !== "/forms") return Response.redirect(`${url.origin}/forms${url.search}`, 301);
  return formsPage(request, env, url);
}
