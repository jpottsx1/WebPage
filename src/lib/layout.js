import { escapeHtml } from "./util.js";

const BASE_STYLE = `
  :root {
    --cream:      #ede3cf;
    --paper:      #f5efe1;
    --teal:       #234e58;
    --teal-dark:  #17343b;
    --gold:       #c9a24b;
    --gold-soft:  #d8b36a;
    --rust:       #b5442e;
    --ink:        #2a2622;
    --muted:      #6f6a5c;
    --line:       rgba(42,38,34,0.14);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: Georgia, 'Times New Roman', serif; color: var(--ink);
    background: var(--cream); line-height: 1.7; -webkit-font-smoothing: antialiased;
  }
  h1, h2, .nav-brand, .eyebrow { font-family: 'Helvetica Neue', Arial, sans-serif; font-weight: 700; color: var(--teal-dark); }
  .eyebrow { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.16em; color: var(--rust); }
  .wrap { width: 100%; max-width: 760px; margin: 0 auto; padding: 0 24px; }
  header { padding: 26px 0; border-bottom: 1px solid var(--line); background: var(--paper); }
  .nav-brand { text-decoration: none; font-size: 1.05rem; letter-spacing: 0.08em; text-transform: uppercase; }
  main { padding: 56px 0 80px; }
  h1 { font-size: 2rem; margin: 10px 0 30px; }
  h2 { font-size: 1.2rem; margin: 40px 0 16px; }
  a { color: var(--rust); }
  .empty { color: var(--muted); }
  footer { background: var(--teal-dark); color: var(--cream); padding: 30px 0; text-align: center; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 0.85rem; }
  footer a { color: var(--gold-soft); }

  /* forms */
  .login-form, .admin-form { background: var(--paper); padding: 30px; border: 1px solid var(--line); max-width: 460px; margin-top: 10px; }
  .login-form label, .admin-form label { display: block; font-family:'Helvetica Neue',Arial,sans-serif; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700; color: var(--teal-dark); margin: 0 0 6px; }
  .login-form input, .admin-form input, .admin-form textarea {
    width: 100%; padding: 12px 14px; margin-bottom: 16px; font-size: 1rem;
    font-family: Georgia, serif; border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 2px;
  }
  .admin-form textarea { min-height: 240px; font-family: Menlo, Consolas, monospace; font-size: 0.9rem; resize: vertical; }
  .btn { display: inline-block; font-family:'Helvetica Neue',Arial,sans-serif; font-weight: 700; font-size: 0.9rem;
    padding: 12px 22px; border-radius: 2px; text-decoration: none; cursor: pointer; border: none; }
  .btn-primary { background: var(--rust); color: #fff; }
  .btn-danger { background: #7a2a1c; color: #fff; }
  .btn-ghost { background: transparent; color: var(--teal-dark); border: 1px solid var(--line); padding: 11px 21px; }
  .error-msg { background: rgba(181,68,46,0.1); border: 1px solid var(--rust); color: var(--rust); padding: 12px 16px; font-family:'Helvetica Neue',Arial,sans-serif; font-size: 0.92rem; margin: 0 0 16px; max-width: 460px; }

  /* lists (downloads + admin) */
  .file-list, .post-admin-list { list-style: none; padding: 0; margin: 20px 0; max-width: 620px; }
  .file-list li, .post-admin-list li {
    display: flex; justify-content: space-between; align-items: center; gap: 14px;
    padding: 16px 0; border-bottom: 1px solid var(--line); font-family: 'Helvetica Neue', Arial, sans-serif;
  }
  .file-list .meta, .post-admin-list .meta { color: var(--muted); font-size: 0.85rem; margin-top: 2px; }
  .row-actions { display: flex; gap: 10px; flex-shrink: 0; }
  .row-actions form { margin: 0; }

  /* blog */
  .post-list { list-style: none; padding: 0; margin: 0; }
  .post-list li { padding: 22px 0; border-bottom: 1px solid var(--line); }
  .post-list li:first-child { padding-top: 0; }
  .post-list a { color: var(--teal-dark); text-decoration: none; font-size: 1.25rem; font-weight: 700; font-family: 'Helvetica Neue', Arial, sans-serif; }
  .post-list a:hover { color: var(--rust); }
  .post-date { display: block; color: var(--muted); font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 0.85rem; margin-bottom: 6px; }
  .post-excerpt { margin: 8px 0 0; }
  .post-body p { margin: 0 0 18px; }
  .post-body img { max-width: 100%; }
`;

export function pageShell({ title, bodyHtml, noindex = false }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
${noindex ? '<meta name="robots" content="noindex, nofollow" />' : ""}
<style>${BASE_STYLE}</style>
</head>
<body>
<header><div class="wrap"><a href="/" class="nav-brand">Jeffrey Potts</a></div></header>
<main><div class="wrap">${bodyHtml}</div></main>
<footer><div class="wrap">&copy; <span id="year"></span> Jeffrey Potts. All rights reserved. &nbsp;&middot;&nbsp; <a href="/">Back to the site</a></div></footer>
<script>document.getElementById('year').textContent = new Date().getFullYear();</script>
</body>
</html>`;
}
