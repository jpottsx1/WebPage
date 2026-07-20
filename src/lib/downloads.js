/**
 * Three password-protected download sections, plus a matching
 * upload/delete admin page for each (its own separate password).
 *
 *   GET/POST /downloads/:slug              — visitor password gate + file list
 *   GET       /downloads/:slug/file/:id     — streams a file (requires visitor session)
 *   GET       /admin/:slug                  — admin password gate + upload/delete UI
 *   POST      /admin/:slug/login            — admin login
 *   POST      /admin/:slug/upload           — add a file
 *   POST      /admin/:slug/delete           — remove a file
 *
 * Section labels below are placeholders — rename the `label` field
 * once each section's purpose is decided; everything else follows
 * from `slug`.
 */

import { escapeHtml, sanitizeFilename, formatDate, formatBytes } from "./util.js";
import { pageShell } from "./layout.js";
import { checkPassword, requireSession, loginCookieHeader, loginFormHtml } from "./auth.js";

const SECTIONS = [
  { slug: "section-1", label: "Section 1", downloadEnv: "DOWNLOAD_PASSWORD_1", adminEnv: "ADMIN_PASSWORD_1" },
  { slug: "section-2", label: "Section 2", downloadEnv: "DOWNLOAD_PASSWORD_2", adminEnv: "ADMIN_PASSWORD_2" },
  { slug: "section-3", label: "Section 3", downloadEnv: "DOWNLOAD_PASSWORD_3", adminEnv: "ADMIN_PASSWORD_3" },
];

function findSection(slug) {
  return SECTIONS.find((s) => s.slug === slug) || null;
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...extraHeaders } });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 303, headers: { Location: location, ...extraHeaders } });
}

async function fetchFiles(env, sectionSlug) {
  const { results } = await env.DB
    .prepare("SELECT id, filename, size_bytes, uploaded_at FROM download_files WHERE section = ? ORDER BY uploaded_at DESC")
    .bind(sectionSlug)
    .all();
  return results;
}

export async function handleDownloadsRequest(request, env, url) {
  const path = url.pathname;

  // ---- serve a file (visitor session required) ----
  let m = path.match(/^\/downloads\/([a-z0-9-]+)\/file\/([a-f0-9-]+)$/);
  if (m) {
    const section = findSection(m[1]);
    if (!section) return null;
    const ok = await requireSession(request, `download-${section.slug}`, env.SESSION_SECRET);
    if (!ok) return redirect(`/downloads/${section.slug}`);
    const row = await env.DB
      .prepare("SELECT * FROM download_files WHERE id = ? AND section = ?")
      .bind(m[2], section.slug)
      .first();
    if (!row) return html("Not found", 404);
    const obj = await env.FILES.get(row.r2_key);
    if (!obj) return html("File missing", 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${sanitizeFilename(row.filename)}"`,
        "Content-Length": String(row.size_bytes),
      },
    });
  }

  // ---- visitor-facing section page ----
  m = path.match(/^\/downloads\/([a-z0-9-]+)\/?$/);
  if (m) {
    const section = findSection(m[1]);
    if (!section) return null;

    if (request.method === "POST") {
      const form = await request.formData();
      const password = (form.get("password") || "").toString();
      const ok = await checkPassword(password, env[section.downloadEnv]);
      if (!ok) {
        return html(
          pageShell({
            title: `${section.label} — Jeffrey Potts`,
            noindex: true,
            bodyHtml: loginFormHtml({ heading: section.label, action: `/downloads/${section.slug}`, error: "Incorrect password." }),
          }),
          401
        );
      }
      const cookie = await loginCookieHeader(`download-${section.slug}`, env.SESSION_SECRET);
      return redirect(`/downloads/${section.slug}`, { "Set-Cookie": cookie });
    }

    const authed = await requireSession(request, `download-${section.slug}`, env.SESSION_SECRET);
    if (!authed) {
      return html(
        pageShell({
          title: `${section.label} — Jeffrey Potts`,
          noindex: true,
          bodyHtml: loginFormHtml({ heading: section.label, action: `/downloads/${section.slug}` }),
        })
      );
    }

    const files = await fetchFiles(env, section.slug);
    const list = files.length
      ? `<ul class="file-list">${files
          .map(
            (f) => `
        <li>
          <div>
            <a href="/downloads/${section.slug}/file/${f.id}">${escapeHtml(f.filename)}</a>
            <div class="meta">${formatBytes(f.size_bytes)} &middot; ${formatDate(f.uploaded_at)}</div>
          </div>
        </li>`
          )
          .join("")}</ul>`
      : `<p class="empty">No files here yet.</p>`;

    return html(
      pageShell({
        title: `${section.label} — Jeffrey Potts`,
        noindex: true,
        bodyHtml: `<p class="eyebrow">Downloads</p><h1>${escapeHtml(section.label)}</h1>${list}`,
      })
    );
  }

  // ---- admin login ----
  m = path.match(/^\/admin\/([a-z0-9-]+)\/login$/);
  if (m && request.method === "POST") {
    const section = findSection(m[1]);
    if (!section) return null;
    const form = await request.formData();
    const password = (form.get("password") || "").toString();
    const ok = await checkPassword(password, env[section.adminEnv]);
    if (!ok) {
      return html(
        pageShell({
          title: `Admin — ${section.label}`,
          noindex: true,
          bodyHtml: loginFormHtml({ heading: `Admin — ${section.label}`, action: `/admin/${section.slug}/login`, error: "Incorrect password." }),
        }),
        401
      );
    }
    const cookie = await loginCookieHeader(`admin-${section.slug}`, env.SESSION_SECRET);
    return redirect(`/admin/${section.slug}`, { "Set-Cookie": cookie });
  }

  // ---- admin upload ----
  m = path.match(/^\/admin\/([a-z0-9-]+)\/upload$/);
  if (m && request.method === "POST") {
    const section = findSection(m[1]);
    if (!section) return null;
    const authed = await requireSession(request, `admin-${section.slug}`, env.SESSION_SECRET);
    if (!authed) return redirect(`/admin/${section.slug}`);
    const form = await request.formData();
    const file = form.get("file");
    if (file && typeof file === "object" && file.size > 0) {
      const id = crypto.randomUUID();
      const filename = sanitizeFilename(file.name || "file");
      const r2Key = `downloads/${section.slug}/${id}-${filename}`;
      await env.FILES.put(r2Key, file.stream(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
      });
      await env.DB
        .prepare("INSERT INTO download_files (id, section, filename, r2_key, size_bytes, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, section.slug, filename, r2Key, file.size, new Date().toISOString())
        .run();
    }
    return redirect(`/admin/${section.slug}`);
  }

  // ---- admin delete ----
  m = path.match(/^\/admin\/([a-z0-9-]+)\/delete$/);
  if (m && request.method === "POST") {
    const section = findSection(m[1]);
    if (!section) return null;
    const authed = await requireSession(request, `admin-${section.slug}`, env.SESSION_SECRET);
    if (!authed) return redirect(`/admin/${section.slug}`);
    const form = await request.formData();
    const id = (form.get("id") || "").toString();
    const row = await env.DB.prepare("SELECT * FROM download_files WHERE id = ? AND section = ?").bind(id, section.slug).first();
    if (row) {
      await env.FILES.delete(row.r2_key);
      await env.DB.prepare("DELETE FROM download_files WHERE id = ?").bind(id).run();
    }
    return redirect(`/admin/${section.slug}`);
  }

  // ---- admin page ----
  m = path.match(/^\/admin\/([a-z0-9-]+)\/?$/);
  if (m) {
    const section = findSection(m[1]);
    if (!section) return null;

    const authed = await requireSession(request, `admin-${section.slug}`, env.SESSION_SECRET);
    if (!authed) {
      return html(
        pageShell({
          title: `Admin — ${section.label}`,
          noindex: true,
          bodyHtml: loginFormHtml({ heading: `Admin — ${section.label}`, action: `/admin/${section.slug}/login` }),
        })
      );
    }

    const files = await fetchFiles(env, section.slug);
    const rows = files.length
      ? `<ul class="file-list">${files
          .map(
            (f) => `
        <li>
          <div>
            <strong>${escapeHtml(f.filename)}</strong>
            <div class="meta">${formatBytes(f.size_bytes)} &middot; ${formatDate(f.uploaded_at)}</div>
          </div>
          <div class="row-actions">
            <form method="POST" action="/admin/${section.slug}/delete" onsubmit="return confirm('Delete this file?');">
              <input type="hidden" name="id" value="${escapeHtml(f.id)}" />
              <button type="submit" class="btn btn-danger">Delete</button>
            </form>
          </div>
        </li>`
          )
          .join("")}</ul>`
      : `<p class="empty">No files uploaded yet.</p>`;

    const bodyHtml = `
      <p class="eyebrow">Admin</p>
      <h1>Manage — ${escapeHtml(section.label)}</h1>
      <form method="POST" action="/admin/${section.slug}/upload" enctype="multipart/form-data" class="admin-form">
        <label for="file">Upload a file</label>
        <input type="file" id="file" name="file" required />
        <button type="submit" class="btn btn-primary">Upload</button>
      </form>
      ${rows}
      <p><a href="/downloads/${section.slug}">View the public page &rarr;</a></p>
    `;
    return html(pageShell({ title: `Admin — ${section.label}`, noindex: true, bodyHtml }));
  }

  return null;
}
