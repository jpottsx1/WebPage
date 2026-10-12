/**
 * GET /press — for journalists, event organisers and booksellers: the bios,
 * the headshot, every cover, and one zip with all of it.
 *
 * The bios live in src/data/press.json (also used by the home page's About
 * section); the books come from src/lib/books.js. The zip at
 * /press/jeffrey-potts-press-kit.zip is built from the same files by
 * tools/build-press-kit.py: rebuild and commit it when a bio, the headshot
 * or a cover changes.
 */

import { escapeHtml } from "./util.js";
import { pageShell } from "./layout.js";
import { BOOKS, coverSrcset, COVER_SIZES } from "./books.js";
import PRESS from "../data/press.json";

const KIT = "/press/jeffrey-potts-press-kit.zip";

const STYLE = `<style>
  .press-section { margin: 0 0 40px; }
  .press-bio { background: var(--surface); padding: 18px 22px; border-left: 3px solid var(--gold); }
  .press-bio p:last-child { margin-bottom: 0; }
  .press-photo { display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr); gap: 24px; align-items: start; }
  .press-photo img, .press-covers img { width: 100%; height: auto; display: block; border-radius: 4px; }
  .press-covers { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 24px; }
  .press-covers strong { display: block; margin-top: 10px; color: var(--heading); }
  .press-covers .meta, .press-photo .meta { display: block; color: var(--muted); font-size: 0.9rem; }
  .copy-btn { margin-top: 10px; }
  @media (max-width: 560px) { .press-photo { grid-template-columns: 1fr; } .press-photo img { max-width: 220px; } }
</style>`;

function coverStatus(b) {
  return b.amazon ? "Out now" : b.badge ? b.badge[0] : "Coming soon";
}

export function handlePressRequest(request, url) {
  if (url.pathname !== "/press" && url.pathname !== "/press/") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (url.pathname === "/press/") return Response.redirect(`${url.origin}/press`, 301);

  const h = PRESS.headshot;
  const bodyHtml = `${STYLE}
    <p class="eyebrow">Press</p>
    <h1>For press, events and booksellers</h1>
    <p>Bios, a photograph and every book cover, free to use when writing about Jeffrey Potts or his books.</p>
    <p><a class="btn btn-primary" href="${KIT}" download>Download the press kit</a></p>
    <p class="meta">One ZIP: both bios as text, the headshot and all ${BOOKS.length} covers.</p>

    <section class="press-section" aria-labelledby="short-bio">
      <h2 id="short-bio">Short bio</h2>
      <div class="press-bio" id="short-bio-text"><p>${escapeHtml(PRESS.shortBio)}</p></div>
      <button type="button" class="btn btn-ghost copy-btn" data-copy="short-bio-text">Copy the short bio</button>
    </section>

    <section class="press-section" aria-labelledby="long-bio">
      <h2 id="long-bio">Long bio</h2>
      <div class="press-bio" id="long-bio-text">${PRESS.longBio.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}</div>
      <button type="button" class="btn btn-ghost copy-btn" data-copy="long-bio-text">Copy the long bio</button>
    </section>

    <section class="press-section" aria-labelledby="photo">
      <h2 id="photo">Photograph</h2>
      <div class="press-photo">
        <picture><source type="image/webp" srcset="${h.webp}" sizes="220px" /><img src="${h.jpg}" alt="Photograph of Jeffrey Potts" width="${h.width}" height="${h.height}" loading="lazy" decoding="async" /></picture>
        <div>
          <p><a href="${h.jpg}" download>Download the headshot (JPG, ${h.width} &times; ${h.height})</a></p>
          <p class="meta">For a larger file, get in touch.</p>
        </div>
      </div>
    </section>

    <section class="press-section" aria-labelledby="covers">
      <h2 id="covers">The books</h2>
      <ul class="press-covers">${BOOKS.map(
        (b) => `<li>
          <a href="/books/${b.slug}"><picture><source type="image/webp" srcset="${coverSrcset(b)}" sizes="${COVER_SIZES.grid}" /><img src="${b.jpg}" alt="${escapeHtml(b.title)} book cover" width="${b.width}" height="${b.height}" loading="lazy" decoding="async" /></picture></a>
          <strong>${escapeHtml(b.fullTitle || b.title)}</strong>
          <span class="meta">${escapeHtml(b.tag)} &middot; ${escapeHtml(coverStatus(b))}</span>
          <a href="${b.jpg}" download>Download cover</a>
        </li>`
      ).join("")}</ul>
    </section>

    <section class="press-section" aria-labelledby="contact">
      <h2 id="contact">Get in touch</h2>
      <p>For interviews, readings, events or review copies, <a href="/#contact">send a message</a> and Jeffrey will answer directly.</p>
    </section>

    <script>
    document.querySelectorAll("[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var text = Array.prototype.map.call(document.getElementById(btn.dataset.copy).querySelectorAll("p"), function (p) { return p.textContent; }).join("\\n\\n");
        var label = btn.textContent;
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = label; }, 2000);
        });
      });
    });
    </script>`;

  return new Response(
    pageShell({
      title: "Press — Jeffrey Potts",
      description: "Bios, a photograph and book covers for writing about author Jeffrey Potts, plus a press kit to download.",
      canonical: "/press",
      image: h.jpg,
      bodyHtml,
    }),
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } }
  );
}
