/**
 * Dynamic blog: public listing/post pages plus a password-gated CMS.
 *
 *   GET       /blog/                    — post list, newest first (live DB query)
 *   GET       /blog/:slug               — single post
 *   GET       /blog/image/:id           — a post's header image
 *   GET       /admin/blog               — password gate + new-post form + post list
 *   POST      /admin/blog/login         — admin login
 *   POST      /admin/blog/new           — create a post
 *   GET/POST  /admin/blog/:id/edit      — edit a post
 *   POST      /admin/blog/delete        — delete a post
 *
 * Post bodies are authored as raw HTML by whoever holds the blog admin
 * password and are rendered unescaped — same trust model as the
 * hand-written posts this replaces. No sanitization is applied.
 */

import { escapeHtml, slugify, formatDate } from "./util.js";
import { pageShell } from "./layout.js";
import { checkPassword, requireSession, loginCookieHeader, loginFormHtml } from "./auth.js";

const ADMIN_AREA = "admin-blog";

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...extraHeaders } });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 303, headers: { Location: location, ...extraHeaders } });
}

async function uniqueSlug(env, title, excludeId) {
  const base = slugify(title);
  let slug = base;
  let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await env.DB.prepare("SELECT id FROM posts WHERE slug = ?").bind(slug).first();
    if (!existing || existing.id === excludeId) return slug;
    slug = `${base}-${n++}`;
  }
}

function excerpt(bodyHtml, len = 160) {
  const text = bodyHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > len ? text.slice(0, len).trim() + "…" : text;
}

function sanitizeImageName(name) {
  return String(name || "image").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

async function renderPublicList(env) {
  const { results } = await env.DB.prepare("SELECT slug, title, body_html, created_at FROM posts ORDER BY created_at DESC").all();
  if (!results.length) {
    return `<p class="empty">No posts yet — <a href="/#signup">sign up for the newsletter</a> and you'll be the first to know when something new goes up.</p>`;
  }
  return `<ul class="post-list">${results
    .map(
      (p) => `
    <li>
      <a href="/blog/${p.slug}">${escapeHtml(p.title)}</a>
      <span class="post-date">${formatDate(p.created_at)}</span>
      <p class="post-excerpt">${escapeHtml(excerpt(p.body_html))}</p>
    </li>`
    )
    .join("")}</ul>`;
}

function renderEditForm(post) {
  return `
    <p class="eyebrow">Admin</p>
    <h1>Edit Post</h1>
    <form method="POST" action="/admin/blog/${post.id}/edit" enctype="multipart/form-data" class="admin-form">
      <label for="title">Title</label>
      <input type="text" id="title" name="title" value="${escapeHtml(post.title)}" required />
      <label for="body">Body (HTML)</label>
      <textarea id="body" name="body" required>${escapeHtml(post.body_html)}</textarea>
      ${post.image_key ? `<p><img src="/blog/image/${post.id}" alt="" style="max-width:200px;display:block;margin-bottom:10px;" /></p>` : ""}
      <label for="image">Replace image (optional)</label>
      <input type="file" id="image" name="image" accept="image/*" />
      <button type="submit" class="btn btn-primary">Save Changes</button>
    </form>
    <p><a href="/admin/blog">&larr; Back to all posts</a></p>
  `;
}

export async function handleBlogRequest(request, env, url) {
  const path = url.pathname;

  // ---- public listing ----
  if (path === "/blog" || path === "/blog/") {
    const list = await renderPublicList(env);
    return html(
      pageShell({
        title: "Blog — Jeffrey Potts",
        bodyHtml: `<p class="eyebrow">The Blog</p><h1>Notes from the desk</h1>${list}`,
      })
    );
  }

  // ---- post image ----
  let m = path.match(/^\/blog\/image\/([a-f0-9-]+)$/);
  if (m) {
    const post = await env.DB.prepare("SELECT image_key FROM posts WHERE id = ?").bind(m[1]).first();
    if (!post || !post.image_key) return html("Not found", 404);
    const obj = await env.FILES.get(post.image_key);
    if (!obj) return html("Not found", 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg",
        "Cache-Control": "public, max-age=31536000",
      },
    });
  }

  // ---- admin: login ----
  if (path === "/admin/blog/login" && request.method === "POST") {
    const form = await request.formData();
    const password = (form.get("password") || "").toString();
    const ok = await checkPassword(password, env.ADMIN_PASSWORD_BLOG);
    if (!ok) {
      return html(
        pageShell({
          title: "Admin — Blog",
          noindex: true,
          bodyHtml: loginFormHtml({ heading: "Admin — Blog", action: "/admin/blog/login", error: "Incorrect password." }),
        }),
        401
      );
    }
    const cookie = await loginCookieHeader(ADMIN_AREA, env.SESSION_SECRET);
    return redirect("/admin/blog", { "Set-Cookie": cookie });
  }

  // ---- admin: create ----
  if (path === "/admin/blog/new" && request.method === "POST") {
    const authed = await requireSession(request, ADMIN_AREA, env.SESSION_SECRET);
    if (!authed) return redirect("/admin/blog");
    const form = await request.formData();
    const title = (form.get("title") || "").toString().trim();
    const body = (form.get("body") || "").toString();
    if (!title || !body) return redirect("/admin/blog");

    const id = crypto.randomUUID();
    const slug = await uniqueSlug(env, title);
    let imageKey = null;
    const image = form.get("image");
    if (image && typeof image === "object" && image.size > 0) {
      imageKey = `blog/${id}-${sanitizeImageName(image.name)}`;
      await env.FILES.put(imageKey, image.stream(), { httpMetadata: { contentType: image.type || "application/octet-stream" } });
    }
    const now = new Date().toISOString();
    await env.DB
      .prepare("INSERT INTO posts (id, slug, title, body_html, image_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, slug, title, body, imageKey, now, now)
      .run();
    return redirect("/admin/blog");
  }

  // ---- admin: edit (form + submit) ----
  m = path.match(/^\/admin\/blog\/([a-f0-9-]+)\/edit$/);
  if (m && request.method === "GET") {
    const authed = await requireSession(request, ADMIN_AREA, env.SESSION_SECRET);
    if (!authed) return redirect("/admin/blog");
    const post = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(m[1]).first();
    if (!post) return html("Not found", 404);
    return html(pageShell({ title: `Edit — ${post.title}`, noindex: true, bodyHtml: renderEditForm(post) }));
  }

  if (m && request.method === "POST") {
    const authed = await requireSession(request, ADMIN_AREA, env.SESSION_SECRET);
    if (!authed) return redirect("/admin/blog");
    const post = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(m[1]).first();
    if (!post) return html("Not found", 404);

    const form = await request.formData();
    const title = (form.get("title") || "").toString().trim() || post.title;
    const body = (form.get("body") || "").toString() || post.body_html;
    let imageKey = post.image_key;
    const image = form.get("image");
    if (image && typeof image === "object" && image.size > 0) {
      if (imageKey) await env.FILES.delete(imageKey);
      imageKey = `blog/${post.id}-${sanitizeImageName(image.name)}`;
      await env.FILES.put(imageKey, image.stream(), { httpMetadata: { contentType: image.type || "application/octet-stream" } });
    }
    const slug = title !== post.title ? await uniqueSlug(env, title, post.id) : post.slug;
    await env.DB
      .prepare("UPDATE posts SET title = ?, slug = ?, body_html = ?, image_key = ?, updated_at = ? WHERE id = ?")
      .bind(title, slug, body, imageKey, new Date().toISOString(), post.id)
      .run();
    return redirect("/admin/blog");
  }

  // ---- admin: delete ----
  if (path === "/admin/blog/delete" && request.method === "POST") {
    const authed = await requireSession(request, ADMIN_AREA, env.SESSION_SECRET);
    if (!authed) return redirect("/admin/blog");
    const form = await request.formData();
    const id = (form.get("id") || "").toString();
    const post = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first();
    if (post) {
      if (post.image_key) await env.FILES.delete(post.image_key);
      await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
    }
    return redirect("/admin/blog");
  }

  // ---- admin: dashboard ----
  if (path === "/admin/blog" || path === "/admin/blog/") {
    const authed = await requireSession(request, ADMIN_AREA, env.SESSION_SECRET);
    if (!authed) {
      return html(
        pageShell({
          title: "Admin — Blog",
          noindex: true,
          bodyHtml: loginFormHtml({ heading: "Admin — Blog", action: "/admin/blog/login" }),
        })
      );
    }

    const { results } = await env.DB.prepare("SELECT id, slug, title, created_at FROM posts ORDER BY created_at DESC").all();
    const rows = results.length
      ? `<ul class="post-admin-list">${results
          .map(
            (p) => `
        <li>
          <div>
            <strong>${escapeHtml(p.title)}</strong>
            <div class="meta">${formatDate(p.created_at)} &middot; <a href="/blog/${p.slug}">view</a></div>
          </div>
          <div class="row-actions">
            <a href="/admin/blog/${p.id}/edit" class="btn btn-ghost">Edit</a>
            <form method="POST" action="/admin/blog/delete" onsubmit="return confirm('Delete this post?');">
              <input type="hidden" name="id" value="${escapeHtml(p.id)}" />
              <button type="submit" class="btn btn-danger">Delete</button>
            </form>
          </div>
        </li>`
          )
          .join("")}</ul>`
      : `<p class="empty">No posts yet.</p>`;

    const bodyHtml = `
      <p class="eyebrow">Admin</p>
      <h1>Blog Posts</h1>
      <h2>New Post</h2>
      <form method="POST" action="/admin/blog/new" enctype="multipart/form-data" class="admin-form">
        <label for="title">Title</label>
        <input type="text" id="title" name="title" required />
        <label for="body">Body (HTML)</label>
        <textarea id="body" name="body" required></textarea>
        <label for="image">Image (optional)</label>
        <input type="file" id="image" name="image" accept="image/*" />
        <button type="submit" class="btn btn-primary">Publish</button>
      </form>
      <h2>Existing Posts</h2>
      ${rows}
    `;
    return html(pageShell({ title: "Admin — Blog", noindex: true, bodyHtml }));
  }

  // ---- single post ----
  m = path.match(/^\/blog\/([a-z0-9-]+)\/?$/);
  if (m) {
    const post = await env.DB.prepare("SELECT * FROM posts WHERE slug = ?").bind(m[1]).first();
    if (!post) return null;
    const imageHtml = post.image_key
      ? `<img src="/blog/image/${post.id}" alt="${escapeHtml(post.title)}" style="width:100%;height:auto;margin:0 0 24px;border:1px solid var(--line);" />`
      : "";
    const bodyHtml = `
      <p class="eyebrow">${formatDate(post.created_at)}</p>
      <h1>${escapeHtml(post.title)}</h1>
      ${imageHtml}
      <div class="post-body">${post.body_html}</div>
      <p style="margin-top:40px;"><a href="/blog/">&larr; Back to all posts</a></p>
    `;
    return html(pageShell({ title: `${post.title} — Jeffrey Potts`, bodyHtml }));
  }

  return null;
}
