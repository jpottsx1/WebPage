/**
 * A page for each book.
 *
 *   GET /books/         — every book, linking to its page
 *   GET /books/<slug>   — cover, description, buy link and JSON-LD Book
 *
 * The data below is the one list of books: these pages, the sitemap, and the
 * home page's book cards (homeCardsHtml, put into index.html by the Worker)
 * all come from it. An upcoming book (no Amazon URL yet) gets a "Tell me when
 * it's out" form; see src/lib/bookalerts.js for releasing one.
 */

import { escapeHtml } from "./util.js";
import { pageShell } from "./layout.js";
import { subscribeBoxHtml } from "./blog.js";
import { SITE_URL } from "./seo.js";
import { bookAlertFormHtml } from "./bookalerts.js";
import PRESS from "../data/press.json";

// amazon: a product URL, or null while the book isn't out (the button then
// becomes an Amazon search, localised by /amazon-links.js like the home page).
// badge: [text, "soon" | "2027"] for unreleased books.
// sample: true when the home page's "Read a Sample" section has its excerpt.
// reviews: reader quotes, shown on the book's page and in the home page's
// "What Readers Say" section. Plain text; escaped when shown.
export const BOOKS = [
  {
    slug: "finding-tina",
    title: "Finding Tina",
    tag: "Memoir · Love",
    genre: "Memoir",
    badge: ["Look for release in 2027", "2027"],
    webp: "/Books/finding-tina.webp",
    jpg: "/Books/Finding%20tina.jpg",
    width: 768,
    height: 1152,
    amazon: null,
    search: "Finding Tina Jeffrey Potts",
    sample: true,
    description:
      "The dating journey that led to the one that mattered most. A wry, tender tour through the near-misses, wrong turns, and Palermo doorways of a life spent looking for love — until it finally looked back.",
  },
  {
    slug: "i-only-cook-supper",
    title: "I Only Cook Supper",
    tag: "Memoir · Cookbook",
    genre: "Memoir",
    badge: ["Look for release in 2027", "2027"],
    webp: "/Books/i-only-cook-supper.webp",
    jpg: "/Books/I%20only%20Cook%20Supper.jpg",
    width: 768,
    height: 1152,
    amazon: null,
    search: "I Only Cook Supper Jeffrey Potts",
    sample: true,
    description:
      "A memoir of food, family, and the key around my neck. Part memoir, part cookbook, all true — the story of a mill-town boyhood told through the meals that held a family together, and the one rule his mother said only once.",
  },
  {
    slug: "most-days",
    title: "Most Days",
    tag: "Memoir · Mental Health",
    genre: "Memoir",
    badge: ["Coming Soon", "soon"],
    webp: "/Books/most-days.webp",
    jpg: "/Books/most-days.jpg",
    width: 800,
    height: 1200,
    amazon: null,
    search: "Most Days Jeffrey Potts memoir",
    sample: true,
    description:
      "A memoir of bipolar disorder. A thirty-year fight, a thousand bad days, and the stubborn act of still getting up. Not recovered, not cured — still here, and telling the truth about what that costs and what it's worth.",
  },
  {
    slug: "eating-stories",
    title: "Eating Stories",
    fullTitle: "Eating Stories: Fun Food, Family & Fabulation",
    tag: "Memoir · Cookbook",
    genre: "Memoir",
    badge: null,
    webp: "/Books/eating-stories.webp",
    jpg: "/Books/Eating%20Stories.jpg",
    width: 938,
    height: 1500,
    amazon: "https://www.amazon.ca/Eating-Stories-Family-Folklore-Fabulation-ebook/dp/B0CPL1CR5S",
    sample: false,
    reviews: [
      { stars: 5, text: "As someone who’s rediscovering the joy of cooking, “Eating Stories: Fun Food, Family & Fabulation” by Jeffrey Potts has been an absolute delight. The recipes themselves are fantastic, but it’s the stories behind them that add a whole new layer of enjoyment. As I read, I could hear his voice and visualize the scenes he painted with his words. It’s like having a conversation with a friend while cooking in the kitchen!", who: "Colleen" },
      { stars: 5, text: "I initially read this on my Kindle, but I found myself craving the tactile experience of flipping through actual pages, so I ordered the paperback. There’s something special about being able to make handwritten notes and immerse myself in these stories in a sunny corner with a cup of tea.", who: "SB" },
    ],
    description:
      "“Eating Stories” is not just a cookbook; it’s a testament to the power of food in connecting us to our past, celebrating our present, and paving the way for future experiences. Join Jeffrey Potts on this captivating journey where food, storytelling, and life beautifully converge, inviting you to create your own tales with each delicious bite.",
  },
  {
    slug: "curling-in-cornwall",
    title: "Curling In Cornwall",
    tag: "History · Sport",
    genre: "History",
    badge: null,
    webp: "/Books/curling-in-cornwall.webp",
    jpg: "/Books/Curling%20In%20Cornwall.jpg",
    width: 960,
    height: 1500,
    amazon: "https://www.amazon.ca/Curling-Cornwall-1784-Early-Years-ebook/dp/B0CW1K8W84",
    sample: false,
    description:
      "The narrative and historical journey of curling in and around Cornwall traces its origins back to the era when the area was first settled by Loyalists, and continues through to the sport’s temporary decline in 1908.",
  },
];

const STYLE = `<style>
  .book-page { display: grid; grid-template-columns: minmax(0, 300px) minmax(0, 1fr); gap: 40px; align-items: start; margin: 8px 0 40px; }
  .book-page .cover { position: relative; }
  .book-page .cover img, .book-grid img { width: 100%; height: auto; display: block; border-radius: 4px; box-shadow: 0 10px 28px rgba(0,0,0,0.22); }
  .book-badge { position: absolute; top: 10px; left: 10px; z-index: 1; color: #fff; font: 700 0.72rem/1.2 'Helvetica Neue', Arial, sans-serif; letter-spacing: 0.06em; padding: 6px 10px; border-radius: 3px; background: var(--teal); }
  .book-badge.soon { background: var(--rust); }
  .book-tag { font: 700 0.72rem/1.4 'Helvetica Neue', Arial, sans-serif; text-transform: uppercase; letter-spacing: 0.16em; color: var(--rust-text); margin: 0 0 8px; }
  .book-page h1 { margin-top: 0; }
  .book-page .description { font-size: 1.12rem; }
  .book-buttons { display: flex; flex-wrap: wrap; gap: 10px; margin: 24px 0 8px; }
  .book-buttons .btn { padding: 11px 20px; }
  .book-grid { list-style: none; padding: 0; margin: 16px 0 40px; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 24px; }
  .book-grid a { text-decoration: none; color: var(--heading); font-weight: 600; }
  .book-grid span { display: block; margin-top: 10px; }
  .book-reviews blockquote { margin: 0 0 20px; padding: 18px 22px; background: var(--surface); border-left: 3px solid var(--gold); }
  .book-reviews .stars { color: var(--gold); letter-spacing: 0.1em; margin: 0 0 6px; }
  .book-reviews blockquote p { margin: 0 0 8px; }
  .book-reviews footer { font: 700 0.85rem/1.4 'Helvetica Neue', Arial, sans-serif; color: var(--muted); }
  .book-alert { border-top: 3px solid var(--rust); background: var(--surface); padding: 22px 24px; margin: 28px 0 8px; }
  .book-alert h2 { margin: 0 0 6px; font-size: 1.2rem; }
  .book-alert p { margin: 0 0 14px; }
  .book-alert label { display: block; font: 700 0.85rem/1.4 'Helvetica Neue', Arial, sans-serif; margin-bottom: 6px; }
  .ba-row { display: flex; gap: 10px; flex-wrap: wrap; }
  .ba-row input { flex: 1 1 220px; min-width: 0; padding: 10px 12px; font-size: 1rem; border: 1px solid var(--line); background: var(--input-bg); color: var(--ink); }
  .book-alert .turnstile-slot { margin-top: 12px; }
  @media (max-width: 640px) {
    .book-page { grid-template-columns: 1fr; gap: 24px; }
    .book-page .cover { max-width: 260px; }
  }
</style>`;

function coverHtml(b, { lazy }) {
  return `<picture><source type="image/webp" srcset="${b.webp}" /><img src="${b.jpg}" alt="${escapeHtml(b.title)} book cover" width="${b.width}" height="${b.height}"${lazy ? ' loading="lazy"' : ""} decoding="async" /></picture>`;
}

function buyHref(b) {
  // "#" plus data-amazon becomes a local Amazon search in /amazon-links.js.
  return b.amazon || "#";
}

function gridHtml(books) {
  return `<ul class="book-grid">${books
    .map((b) => `<li><a href="/books/${b.slug}">${coverHtml(b, { lazy: true })}<span>${escapeHtml(b.title)}</span></a></li>`)
    .join("")}</ul>`;
}

/** The home page's book cards, in the markup and classes index.html styles. */
export function homeCardsHtml() {
  return BOOKS.map((b) => {
    const badge = b.badge ? `<span class="badge badge-${b.badge[1]}">${escapeHtml(b.badge[0])}</span>` : "";
    const primary = b.amazon
      ? `<a class="btn btn-primary" href="${escapeHtml(b.amazon)}" target="_blank" rel="noopener">Buy on Amazon</a>`
      : `<a class="btn btn-primary" href="/books/${b.slug}#alert">Tell me when it&rsquo;s out</a>`;
    return `
      <article class="book">
        <div class="book-cover">${badge}<a href="/books/${b.slug}" tabindex="-1" aria-hidden="true">${coverHtml(b, { lazy: true })}</a></div>
        <div class="book-body">
          <div class="book-tag">${escapeHtml(b.tag)}</div>
          <h3><a href="/books/${b.slug}">${escapeHtml(b.title)}</a></h3>
          <p>${escapeHtml(b.description)}</p>
          <div class="book-actions">
            ${primary}
            ${b.sample ? `<a class="btn btn-ghost" href="#sample">Read a Sample</a>` : ""}
          </div>
        </div>
      </article>`;
  }).join("\n");
}

const STARS = (n) => "\u2605".repeat(n);

/** Every review, for the home page's "What Readers Say" (index.html's .quotes styles). */
export function homeReviewsHtml() {
  return BOOKS.flatMap((b) => (b.reviews || []).map((r) => `
      <blockquote class="quote">
        <div class="stars" aria-label="${r.stars} out of 5 stars">${STARS(r.stars)}</div>
        <p>${escapeHtml(r.text)}</p>
        <span class="who">&mdash; ${escapeHtml(r.who)}, on <a href="/books/${b.slug}">${escapeHtml(b.title)}</a></span>
      </blockquote>`)).join("\n");
}

function reviewsHtml(b) {
  if (!b.reviews || !b.reviews.length) return "";
  return `<section class="book-reviews" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading">What readers say</h2>
      ${b.reviews.map((r) => `<blockquote>
        <p class="stars" aria-label="${r.stars} out of 5 stars">${STARS(r.stars)}</p>
        <p>${escapeHtml(r.text)}</p>
        <footer>&mdash; ${escapeHtml(r.who)}</footer>
      </blockquote>`).join("")}
    </section>`;
}

/** The home page with its book cards, reviews and About text filled in. */
export async function homePage(request, env) {
  const res = await env.ASSETS.fetch(request);
  if (!res.ok || !(res.headers.get("Content-Type") || "").includes("text/html")) return res;
  return new HTMLRewriter()
    .on("div.books[data-books]", { element: (el) => el.setInnerContent(homeCardsHtml(), { html: true }) })
    .on("div.quotes[data-reviews]", { element: (el) => el.setInnerContent(homeReviewsHtml(), { html: true }) })
    .on("div.about-body[data-bio]", { element: (el) => el.setInnerContent(PRESS.longBio.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n"), { html: true }) })
    .transform(res);
}

const AMAZON_SCRIPT = `<script src="/amazon-links.js" defer></script>`;

function html(body) {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

function bookPage(b) {
  const others = BOOKS.filter((o) => o.slug !== b.slug);
  const buyLabel = b.amazon ? "Buy on Amazon" : "Find it on Amazon";
  const bodyHtml = `${STYLE}
    <p class="eyebrow"><a href="/books/">The books</a></p>
    <article class="book-page">
      <div class="cover">${b.badge ? `<span class="book-badge${b.badge[1] === "soon" ? " soon" : ""}">${escapeHtml(b.badge[0])}</span>` : ""}${coverHtml(b, { lazy: false })}</div>
      <div>
        <p class="book-tag">${escapeHtml(b.tag)}</p>
        <h1>${escapeHtml(b.fullTitle || b.title)}</h1>
        <p class="meta">By Jeffrey Potts${b.badge ? ` · ${escapeHtml(b.badge[0])}` : " · Paperback and ebook"}</p>
        <p class="description">${escapeHtml(b.description)}</p>
        <div class="book-buttons">
          <a class="btn btn-primary" href="${escapeHtml(buyHref(b))}"${b.amazon ? "" : ` data-amazon="${escapeHtml(b.search)}"`} target="_blank" rel="noopener">${buyLabel}</a>
          ${b.sample ? `<a class="btn btn-ghost" href="/#sample">Read a Sample</a>` : ""}
        </div>
        ${b.amazon ? "" : bookAlertFormHtml(b)}
      </div>
    </article>
    ${reviewsHtml(b)}
    ${subscribeBoxHtml()}
    <h2>More books</h2>
    ${gridHtml(others)}
    ${AMAZON_SCRIPT}`;

  const book = {
    "@context": "https://schema.org",
    "@type": "Book",
    name: b.fullTitle || b.title,
    author: { "@type": "Person", "@id": `${SITE_URL}/#jeff`, name: "Jeffrey Potts", url: `${SITE_URL}/` },
    image: SITE_URL + b.jpg,
    url: `${SITE_URL}/books/${b.slug}`,
    description: b.description,
    genre: b.genre,
    inLanguage: "en",
  };
  if (b.amazon) book.sameAs = b.amazon;

  return html(
    pageShell({
      title: `${b.title} — Jeffrey Potts`,
      description: b.description.length > 160 ? b.description.slice(0, 157).trim() + "…" : b.description,
      canonical: `/books/${b.slug}`,
      image: b.jpg,
      ogType: "book",
      jsonLd: book,
      bodyHtml,
    })
  );
}

function indexPage() {
  const bodyHtml = `${STYLE}
    <p class="eyebrow">The Books</p>
    <h1>True stories worth your evening</h1>
    <p>Memoir, food and local history, in paperback and ebook. Pick a cover to read more.</p>
    ${gridHtml(BOOKS)}
    ${subscribeBoxHtml()}`;
  return html(
    pageShell({
      title: "Books — Jeffrey Potts",
      description: "Every book by Jeffrey Potts: Finding Tina, I Only Cook Supper, Most Days, Eating Stories and Curling In Cornwall.",
      canonical: "/books/",
      image: "/Jeffreypotts.jpg",
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "ItemList",
        itemListElement: BOOKS.map((b, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE_URL}/books/${b.slug}`, name: b.title })),
      },
      bodyHtml,
    })
  );
}

export function handleBooksRequest(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const path = url.pathname;
  if (path === "/books") return Response.redirect(`${url.origin}/books/`, 301);
  if (path === "/books/") return indexPage();
  const m = path.match(/^\/books\/([a-z0-9-]+)\/?$/);
  if (!m) return null;
  const book = BOOKS.find((b) => b.slug === m[1]);
  if (!book) return null;
  if (path.endsWith("/")) return Response.redirect(`${url.origin}/books/${book.slug}`, 301);
  return bookPage(book);
}
