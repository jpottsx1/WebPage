/**
 * Cloudflare Worker — entry point
 * ------------------------------------------------------------------
 * Serves the static site and handles:
 *   POST /api/subscribe — newsletter signups
 *     1. Validates the submitted name + email
 *     2. Stores the subscriber in a D1 database (duplicate-safe)
 *     3. Sends a welcome email to the subscriber via Resend
 *     4. (Optional) emails the author a notification of the new signup
 *   POST /api/contact — contact form
 *     1. Validates name + email + message (honeypot field rejects bots)
 *     2. Emails the message to the author via Resend, reply-to the sender
 *
 * Required bindings / variables (set in Cloudflare dashboard):
 *   DB              — D1 database binding (declared in wrangler.jsonc)
 *   RESEND_API_KEY  — secret, Resend API key
 *   FROM_EMAIL      — e.g. "Jeffrey Potts <me@jeffreypotts.ca>"
 *   NOTIFY_EMAIL    — where new-signup alerts and contact messages go
 *                     (required for /api/contact, optional for signups)
 *
 * See SETUP.md for the one-time setup steps.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleSubscribe(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { error: "Invalid request body." });
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

  // ---- store the subscriber ----
  const createdAt = new Date().toISOString();
  try {
    await env.DB
      .prepare("INSERT INTO subscribers (email, name, created_at) VALUES (?, ?, ?)")
      .bind(email, name, createdAt)
      .run();
  } catch (e) {
    // Unique-constraint race → treat as duplicate; anything else → 500
    if (String(e && e.message).toUpperCase().includes("UNIQUE")) {
      return json(409, { error: "already subscribed" });
    }
    return json(500, { error: "Could not save your signup. Please try again." });
  }

  // ---- send the welcome email (non-blocking for the signup) ----
  const firstName = name.split(/\s+/)[0] || "friend";
  if (env.RESEND_API_KEY && env.FROM_EMAIL) {
    try {
      await sendEmail(env, {
        to: email,
        subject: "Welcome — your first early chapter is coming",
        html: welcomeHtml(firstName),
      });
    } catch (e) {
      // Subscriber is already saved; don't fail the request over email delivery.
    }

    // ---- optional: notify the author ----
    if (env.NOTIFY_EMAIL) {
      try {
        await sendEmail(env, {
          to: env.NOTIFY_EMAIL,
          subject: "New newsletter signup",
          html: `<p>New subscriber:</p><p><strong>${escapeHtml(name)}</strong><br>${escapeHtml(email)}<br>${createdAt}</p>`,
        });
      } catch (e) { /* ignore */ }
    }
  }

  return json(201, { ok: true });
}

async function handleContact(request, env) {
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
async function sendEmail(env, { to, subject, html, replyTo }) {
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
    }),
  });
  if (!res.ok) {
    throw new Error("Resend failed: " + res.status);
  }
  return res;
}

function welcomeHtml(firstName) {
  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; color:#2a2622; max-width:560px; margin:0 auto; line-height:1.6;">
    <h1 style="font-family:Arial,Helvetica,sans-serif; color:#234e58; font-size:22px;">Welcome aboard, ${escapeHtml(firstName)}.</h1>
    <p>Thank you for signing up — you&rsquo;re officially on the list.</p>
    <p>You&rsquo;ll be among the first to read new chapters and writing samples, hear about launches, and get the occasional story from behind the pages. No spam, no filler — just the work, a little early.</p>
    <p>Your first early chapter is on its way shortly. In the meantime, thank you for reading.</p>
    <p style="margin-top:28px;">— Jeffrey Potts</p>
    <hr style="border:none; border-top:1px solid #e3d6b8; margin:28px 0;">
    <p style="font-family:Arial,Helvetica,sans-serif; font-size:12px; color:#6f6a5c;">
      You received this because you signed up at jeffreypotts.ca. If this wasn&rsquo;t you, simply ignore this email.
    </p>
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/subscribe" && request.method === "POST") {
      return handleSubscribe(request, env);
    }
    if (url.pathname === "/api/contact" && request.method === "POST") {
      return handleContact(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
