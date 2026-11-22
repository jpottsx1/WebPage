/**
 * GET /forms — the printable forms from When Your Mind and Money Collide.
 *
 * The book sends readers to jeffreypotts.ca/Forms for PDF copies of every
 * form and script, so /Forms (any capitalisation, with or without a slash)
 * redirects here. The list lives in src/data/forms.json; the PDFs in /forms
 * are cut from the book's print interior by tools/build-forms.py.
 */

import { escapeHtml } from "./util.js";
import { pageShell } from "./layout.js";
import { BOOKS } from "./books.js";
import { subscribeBoxHtml } from "./blog.js";
import FORMS from "../data/forms.json";

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
  .forms-help { background: var(--surface); border-left: 3px solid var(--gold); padding: 16px 20px; margin: 8px 0 36px; }
  .forms-help p { margin: 0; }
  @media (max-width: 560px) { .forms-list li { flex-direction: column; gap: 2px; } }
</style>`;

const slugify = (s) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function chapters() {
  const out = [];
  for (const f of FORMS.forms) {
    if (!out.length || out[out.length - 1].name !== f.chapter) out.push({ name: f.chapter, id: slugify(f.chapter), forms: [] });
    out[out.length - 1].forms.push(f);
  }
  return out;
}

const pageCount = (f) => f.sourcePages.length;

export function handleFormsRequest(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const path = url.pathname.toLowerCase();
  if (path !== "/forms" && path !== "/forms/") return null;
  if (url.pathname !== "/forms") return Response.redirect(`${url.origin}/forms`, 301);

  const book = BOOKS.find((b) => b.slug === FORMS.book);
  const groups = chapters();
  const totalPages = FORMS.forms.reduce((n, f) => n + pageCount(f), 0);

  const bodyHtml = `${STYLE}
    <p class="eyebrow"><a href="/books/${book.slug}">${escapeHtml(book.title)}</a></p>
    <h1>Printable forms and scripts</h1>
    <div class="forms-intro">
      <p>Every worksheet, letter, script and checklist from <a href="/books/${book.slug}"><em>${escapeHtml(book.fullTitle || book.title)}</em></a>, as a PDF you can print or fill in on your computer. Each one is listed under its chapter, with the page it&rsquo;s on in the book.</p>
      <p>They&rsquo;re free, with no sign-up. Print a fresh copy whenever you need one.</p>
    </div>
    <div class="forms-all">
      <a class="btn btn-primary" href="${FORMS.all}" download>Download every form (one PDF)</a>
      <span class="meta">${FORMS.forms.length} forms, ${totalPages} pages</span>
    </div>

    <div class="forms-help">
      <p><strong>In crisis right now?</strong> Call or text <a href="tel:988">988</a>, the Suicide Crisis Helpline, any time. In an emergency, call 911.</p>
    </div>

    <nav aria-label="Chapters">
      <ol class="forms-toc">${groups.map((g) => `<li><a href="#${g.id}">${escapeHtml(g.name)}</a></li>`).join("")}</ol>
    </nav>

    ${groups
      .map(
        (g) => `<section class="forms-chapter" id="${g.id}" aria-labelledby="${g.id}-h">
      <h2 id="${g.id}-h">${escapeHtml(g.name)}</h2>
      <ul class="forms-list">${g.forms
        .map(
          (f) => `<li><a href="${f.file}" download>${escapeHtml(f.title)}</a><span class="meta">Page ${f.page} &middot; PDF${pageCount(f) > 1 ? `, ${pageCount(f)} pages` : ""}</span></li>`
        )
        .join("")}</ul>
    </section>`
      )
      .join("\n")}

    <p>Don&rsquo;t have the book yet? <a href="/books/${book.slug}">Read about it</a> or <a href="${escapeHtml(book.amazon)}" target="_blank" rel="noopener">buy it on Amazon</a>.</p>
    ${subscribeBoxHtml()}`;

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
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } }
  );
}
