/**
 * Error alerts: an email when the site is broken, before a reader notices.
 *
 *   Live errors   — a request that throws, or answers with a 5xx, emails the
 *                   site owner. At most once an hour per kind of failure.
 *   Health check  — runs every morning (the cron in wrangler.jsonc) and on
 *                   /admin/health: checks every setting, secret, binding and
 *                   database table the site needs, that the Resend key is
 *                   accepted and that the Turnstile secret is valid. Emails
 *                   only when something is wrong.
 *
 * Alerts go to ALERT_EMAIL, else NOTIFY_EMAIL, else the site's own address,
 * from FROM_EMAIL, else an alerts@ address on the site's domain, so a
 * missing email setting can still be reported. The throttle uses the
 * rate_events table.
 */

import { escapeHtml } from "./util.js";

const HOUR_MS = 60 * 60 * 1000;

async function throttled(env, kind) {
  try {
    const key = `alert:${kind}`;
    const now = Date.now();
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND at > ?").bind(key, now - HOUR_MS).first();
    if (row && row.n > 0) return true;
    await env.DB.prepare("INSERT INTO rate_events (key, at) VALUES (?, ?)").bind(key, now).run();
  } catch (e) {
    // No database: send anyway rather than stay silent.
  }
  return false;
}

/** Emails an alert. `force` skips the hourly throttle (test alerts). */
export async function sendAlert(env, config, { kind, subject, lines, force = false }) {
  if (!force && (await throttled(env, kind))) return { sent: false, reason: "throttled" };
  const text = lines.join("\n");
  console.error(`[alert] ${config.site}: ${subject}\n${text}`);
  if (!env.RESEND_API_KEY) return { sent: false, reason: "RESEND_API_KEY isn't set" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.FROM_EMAIL || config.defaultFrom,
      to: [env.ALERT_EMAIL || env.NOTIFY_EMAIL || config.defaultTo],
      subject: `[${config.site}] ${subject}`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:640px;">
  <p><strong>${escapeHtml(subject)}</strong></p>
  <ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
  <p style="color:#666;">Checked ${escapeHtml(new Date().toISOString())}. Run the checks yourself at <a href="https://${config.site}/admin/health">${escapeHtml(config.site)}/admin/health</a>.</p>
</div>`,
    }),
  }).catch((e) => ({ ok: false, status: 0, statusText: e.message }));
  return res.ok ? { sent: true } : { sent: false, reason: `Resend ${res.status}` };
}

/** Wraps a fetch handler: alerts on thrown errors and 5xx responses. */
export function withErrorAlerts(handler, config) {
  return async (request, env, ctx) => {
    const path = new URL(request.url).pathname;
    try {
      const res = await handler(request, env, ctx);
      if (res.status >= 500) {
        ctx.waitUntil(
          sendAlert(env, config, {
            kind: `5xx:${path}`,
            subject: `A page answered ${res.status}`,
            lines: [`${request.method} ${path} returned ${res.status}.`, "It may be a missing setting; /admin/health checks them all."],
          })
        );
      }
      return res;
    } catch (e) {
      ctx.waitUntil(
        sendAlert(env, config, {
          kind: `exception:${path}`,
          subject: "The site hit an error",
          lines: [`${request.method} ${path} threw: ${e && e.message}`, String((e && e.stack) || "").slice(0, 1500)],
        })
      );
      return new Response("Something went wrong on our side. Please try again in a moment.", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  };
}

/**
 * Every problem found, as plain sentences; an empty list means healthy.
 * config: { required: [names of env values that must be set], tables: [...] }
 */
export async function healthCheck(env, config) {
  const problems = [];
  for (const name of config.required) {
    if (env[name] === undefined || env[name] === null || env[name] === "") problems.push(`${name} isn't set.`);
  }

  if (env.DB) {
    try {
      const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      const have = new Set(results.map((r) => r.name));
      for (const t of config.tables) if (!have.has(t)) problems.push(`The ${t} database table is missing (run schema.sql).`);
    } catch (e) {
      problems.push(`The database didn't answer: ${e.message}`);
    }
  }

  if (env.RESEND_API_KEY) {
    // A sending-only key can't list domains and says so (restricted_api_key),
    // which still proves Resend recognises it.
    try {
      const r = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        if (body.name !== "restricted_api_key") problems.push(`Resend rejected RESEND_API_KEY (${r.status} ${body.name || ""}).`.trim());
      }
    } catch (e) {
      problems.push(`Couldn't reach Resend: ${e.message}`);
    }
  }

  if (env.TURNSTILE_SECRET) {
    try {
      const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: "XXXX.DUMMY.TOKEN.XXXX" }),
      });
      const d = await r.json();
      if ((d["error-codes"] || []).includes("invalid-input-secret")) problems.push("Turnstile rejected TURNSTILE_SECRET, so the forms will refuse everyone.");
    } catch (e) {
      problems.push(`Couldn't reach Turnstile: ${e.message}`);
    }
  }
  return problems;
}

/** The daily cron: email only if something's wrong. */
export async function scheduledHealthCheck(env, config) {
  const problems = await healthCheck(env, config);
  if (!problems.length) {
    console.log(`[health] ${config.site}: all checks passed`);
    return;
  }
  await sendAlert(env, config, {
    kind: "health",
    subject: `${problems.length} problem${problems.length === 1 ? "" : "s"} found by the daily check`,
    lines: problems,
  });
}

/**
 * The hourly cron: is the other site up? A site can't report its own outage,
 * so jeffreypotts.ca and sgeulai.com each check the other. A URL that fails
 * twice, a few seconds apart, sends an alert (at most once an hour).
 */
export async function checkOtherSite(env, config, urls) {
  const failures = [];
  for (const url of urls) {
    let problem = await probe(url);
    if (problem) {
      await new Promise((r) => setTimeout(r, 5000));
      problem = await probe(url);
    }
    if (problem) failures.push(`${url}: ${problem}`);
  }
  if (!failures.length) return;
  await sendAlert(env, config, {
    kind: "other-site-down",
    subject: `${new URL(urls[0]).host} looks down`,
    lines: [...failures, `Checked from ${config.site}, twice, five seconds apart. Its own error alerts can't reach you if it's down.`],
  });
}

async function probe(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "uptime-check (other site's cron)" }, signal: AbortSignal.timeout(15000) });
    return r.ok ? null : `answered ${r.status}`;
  } catch (e) {
    return e.name === "TimeoutError" ? "no answer within 15 seconds" : `couldn't connect (${e.message})`;
  }
}
