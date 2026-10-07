/**
 * Search-engine plumbing.
 *
 *   GET /robots.txt   — crawl rules + sitemap location
 *   GET /sitemap.xml  — home page, blog index, every post and tag page
 *   GET /blog/feed.xml (also /feed.xml, /rss.xml) — RSS feed of the latest posts
 */

import { escapeHtml } from "./util.js";
import { excerpt } from "./blog.js";

export const SITE_URL = "https://jeffreypotts.ca";

function xml(body, type) {
  return new Response(body, {
    headers: { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "public, max-age=3600" },
  });
}

function isoDate(s) {
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

export async function handleSeoRequest(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const path = url.pathname;

  if (path === "/robots.txt") {
    return new Response(
      `User-agent: *\nDisallow: /admin/\nDisallow: /downloads/\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
      { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } }
    );
  }

  if (path === "/sitemap.xml") {
    const { results: posts } = await env.DB.prepare(
      "SELECT slug, created_at, updated_at FROM posts ORDER BY created_at DESC"
    ).all();
    const { results: tags } = await env.DB.prepare("SELECT DISTINCT slug FROM post_tags").all();
    const latest = posts.length ? isoDate(posts[0].updated_at || posts[0].created_at) : null;
    const entries = [
      { loc: `${SITE_URL}/` },
      { loc: `${SITE_URL}/blog/`, lastmod: latest },
      ...posts.map((p) => ({ loc: `${SITE_URL}/blog/${p.slug}`, lastmod: isoDate(p.updated_at || p.created_at) })),
      ...tags.map((t) => ({ loc: `${SITE_URL}/blog/tag/${t.slug}` })),
    ];
    const body = entries
      .map((e) => `  <url><loc>${escapeHtml(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`)
      .join("\n");
    return xml(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
      "application/xml"
    );
  }

  if (path === "/blog/feed.xml" || path === "/feed.xml" || path === "/rss.xml") {
    const { results: posts } = await env.DB.prepare(
      "SELECT slug, title, body_html, created_at FROM posts ORDER BY created_at DESC LIMIT 30"
    ).all();
    const items = posts
      .map((p) => {
        const link = `${SITE_URL}/blog/${p.slug}`;
        const d = new Date(p.created_at);
        return `    <item>
      <title>${escapeHtml(p.title)}</title>
      <link>${escapeHtml(link)}</link>
      <guid isPermaLink="true">${escapeHtml(link)}</guid>
      ${isNaN(d) ? "" : `<pubDate>${d.toUTCString()}</pubDate>`}
      <description>${escapeHtml(excerpt(p.body_html, 300))}</description>
    </item>`;
      })
      .join("\n");
    return xml(
      `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Jeffrey Potts — Blog</title>
    <link>${SITE_URL}/blog/</link>
    <description>Notes from the desk of author Jeffrey Potts.</description>
    <language>en</language>
    <atom:link href="${SITE_URL}/blog/feed.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`,
      "application/rss+xml"
    );
  }

  return null;
}
