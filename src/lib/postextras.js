/**
 * Blog extras: reading time, older/newer post links, and share links.
 *
 * Share links are plain links to each service's own share page: no
 * third-party scripts, buttons or trackers load on the page. "Copy link"
 * uses the clipboard, and a native "Share…" button appears only in browsers
 * that support the Web Share API (mostly phones).
 */

import { escapeHtml } from "./util.js";

const WORDS_PER_MINUTE = 230;

export function readingMinutes(bodyHtml) {
  const text = String(bodyHtml || "").replace(/<[^>]+>/g, " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export function readingTime(bodyHtml) {
  return `${readingMinutes(bodyHtml)} min read`;
}

export async function adjacentPosts(env, post) {
  const [older, newer] = await Promise.all([
    env.DB.prepare("SELECT slug, title FROM posts WHERE created_at < ? ORDER BY created_at DESC LIMIT 1").bind(post.created_at).first(),
    env.DB.prepare("SELECT slug, title FROM posts WHERE created_at > ? ORDER BY created_at ASC LIMIT 1").bind(post.created_at).first(),
  ]);
  return { older, newer };
}

export function postNavHtml({ older, newer }) {
  if (!older && !newer) return "";
  const link = (p, rel, label) =>
    p ? `<a href="/blog/${escapeHtml(p.slug)}" rel="${rel}" class="post-nav-${rel}"><span>${label}</span>${escapeHtml(p.title)}</a>` : "<span></span>";
  return `
      <nav class="post-nav" aria-label="More posts">
        ${link(older, "prev", "Older")}
        ${link(newer, "next", "Newer")}
      </nav>`;
}

export function shareHtml(url, title) {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  const both = encodeURIComponent(`${title} ${url}`);
  const services = [
    ["Email", `mailto:?subject=${t}&body=${u}`],
    ["Bluesky", `https://bsky.app/intent/compose?text=${both}`],
    ["Facebook", `https://www.facebook.com/sharer/sharer.php?u=${u}`],
    ["LinkedIn", `https://www.linkedin.com/sharing/share-offsite/?url=${u}`],
    ["X", `https://x.com/intent/post?text=${t}&url=${u}`],
  ];
  const links = services
    .map(([name, href]) =>
      name === "Email"
        ? `<a href="${escapeHtml(href)}">${name}</a>`
        : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${name}</a>`
    )
    .join("");
  return `
      <div class="post-share" data-url="${escapeHtml(url)}" data-title="${escapeHtml(title)}">
        <span class="post-share-label">Share</span>
        <button type="button" class="post-share-native" hidden>Share&hellip;</button>
        ${links}
        <button type="button" class="post-share-copy">Copy link</button>
        <span class="post-share-status" role="status" aria-live="polite"></span>
      </div>
      <script>
      (function () {
        var box = document.querySelector(".post-share");
        if (!box) return;
        var url = box.dataset.url, title = box.dataset.title;
        var status = box.querySelector(".post-share-status");
        var native = box.querySelector(".post-share-native");
        if (navigator.share) {
          native.hidden = false;
          native.addEventListener("click", function () {
            navigator.share({ title: title, url: url }).catch(function () {});
          });
        }
        box.querySelector(".post-share-copy").addEventListener("click", function () {
          var done = function () { status.textContent = "Link copied"; setTimeout(function () { status.textContent = ""; }, 2500); };
          if (navigator.clipboard) {
            navigator.clipboard.writeText(url).then(done, function () { status.textContent = url; });
          } else {
            status.textContent = url;
          }
        });
      })();
      </script>`;
}
