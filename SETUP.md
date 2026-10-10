# Newsletter backend — one-time setup

Your site runs on Cloudflare Workers with static assets (deployed from
GitHub). This adds a backend that stores subscribers and sends a welcome
email — all on Cloudflare's free tier, with GitHub still in charge of
deploys. You do **not** need to move your domain off Namecheap.

The code is already in the repo:
- `src/worker.js` — serves the site and handles `POST /api/subscribe` and `POST /api/contact`
- `wrangler.jsonc` — declares the `DB` (D1) binding in code
- `schema.sql` — the database table
- The signup and contact forms post to their endpoints automatically.

You just need to do the clicks below once.

---

## 1. Create the D1 database (stores your subscriber list)

1. Cloudflare dashboard → **Storage & Databases → D1** → **Create database**.
2. Name it `jeffreypotts-newsletter` → Create.
3. Open the new database → **Console** tab → paste this and run it:

   ```sql
   CREATE TABLE IF NOT EXISTS subscribers (
     email      TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   ```

## 2. Bind the database

Already done in code — `wrangler.jsonc` declares the `DB` binding pointing at
`jeffreypotts-newsletter`. It takes effect automatically on the next deploy;
no dashboard step needed.

## 3. Set up Resend (sends the email)

1. Create a free account at **resend.com**.
2. **Domains → Add Domain** → enter `jeffreypotts.ca`.
3. Resend shows you a set of DNS records (DKIM + SPF, and an MX for a `send`
   subdomain). Copy them.
4. In **Namecheap → Domain List → jeffreypotts.ca → Manage → Advanced DNS**,
   add each record exactly as shown (Type, Host, Value). Save.
   - These only affect *sending*. Your existing inbox at me@jeffreypotts.ca is untouched.
5. Back in Resend, click **Verify**. (DNS can take a few minutes to an hour.)
6. **API Keys → Create API Key** → copy it (starts with `re_`). You only see it once.

> Before the domain verifies, Resend runs in test mode — it can only email your
> own address. Once verified, it can email any subscriber.

## 4. Add the secrets to your Worker

Cloudflare dashboard → **Workers & Pages** → your site → **Settings →
Variables and Secrets** → add these three, then **Save and deploy**:

| Variable | Value | Type |
|---|---|---|
| `RESEND_API_KEY` | your `re_...` key | **Encrypt** (secret) |
| `FROM_EMAIL` | `Jeffrey Potts <me@jeffreypotts.ca>` | Text |
| `NOTIFY_EMAIL` | `me@jeffreypotts.ca` | Text |

`NOTIFY_EMAIL` is now **required** — it's where contact form messages are
delivered, and it also gets a copy of each newsletter signup.

## 5. Create the R2 bucket (stores downloadable files + blog images)

1. Cloudflare dashboard → **Storage & Databases → R2** → **Create bucket**.
2. Name it exactly `jeffreypotts-files` → Create. (`wrangler.jsonc` already
   declares the `FILES` binding pointing at this name — no dashboard binding
   step needed, same as the D1 database.)

## 6. Run the new database tables

Cloudflare dashboard → **D1 → jeffreypotts-newsletter → Console** → paste and
run:

```sql
CREATE TABLE IF NOT EXISTS download_files (
  id          TEXT PRIMARY KEY,
  section     TEXT NOT NULL,
  filename    TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_download_files_section ON download_files (section, uploaded_at);

CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  body_html   TEXT NOT NULL,
  image_key   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts (created_at);
```

(This is also in `schema.sql` if you'd rather run it via `wrangler d1
execute` instead of pasting into the console.)

## 7. Add the password secrets

Same **Settings → Variables and Secrets** screen as step 4. Add all of
these, each type **Encrypt (secret)**, then **Save and deploy**:

| Variable | Purpose |
|---|---|
| `DOWNLOAD_PASSWORD_1` | Visitor password for Section 1's download page |
| `DOWNLOAD_PASSWORD_2` | Visitor password for Section 2's download page |
| `DOWNLOAD_PASSWORD_3` | Visitor password for Section 3's download page |
| `ADMIN_PASSWORD_1` | Admin password to upload/delete files in Section 1 |
| `ADMIN_PASSWORD_2` | Admin password to upload/delete files in Section 2 |
| `ADMIN_PASSWORD_3` | Admin password to upload/delete files in Section 3 |
| `ADMIN_PASSWORD_BLOG` | Admin password for the blog CMS (add/edit/delete posts) |
| `SESSION_SECRET` | Any long random string (e.g. from a password generator) — signs login-session cookies. Not a password you use yourself; just needs to be unpredictable. |

Pick strong, unique values for each — whoever holds `DOWNLOAD_PASSWORD_1`
can only see Section 1's files; `ADMIN_PASSWORD_1` is a separate, more
sensitive password that also lets someone delete those files, so keep
admin passwords to yourself.

## 8. Deploy and test

1. Push (already done) → Cloudflare redeploys the Worker automatically.
2. Go to your live site, sign up with your own email.
3. You should get the welcome email, and the subscriber should appear in D1.

---

## Your subscribers and sending the newsletter

Go to **/admin/newsletter** and sign in with the blog admin password
(`ADMIN_PASSWORD_BLOG`). There's also a link from `/admin/blog`. From there you can:

- **See and remove subscribers.** Removing someone deletes them straight away.
- **Export to Excel:** *Export subscribers (CSV)* downloads the list.
- **Send a newsletter:** write a subject and an HTML body (`{{name}}` becomes
  each reader's first name). Use **Send me a test** first; it goes to
  `NOTIFY_EMAIL`. **Send to N subscribers** emails everyone. Each email gets
  its own unsubscribe link, and mail apps show their built-in Unsubscribe
  button. The same subject can't be sent twice within an hour, so a
  double-click won't send it twice.

One-time setup:

1. Re-run `schema.sql` (step 6). It adds the `newsletters` table, and
   re-running it is safe.
2. Add a **`MAILING_ADDRESS`** variable (Text), for example
   `PO Box 123, Halifax NS B3H 0A1`. It's printed in the footer of every
   email; Canada's anti-spam law (CASL) expects a mailing address in
   commercial email. A PO box is fine.

Unsubscribe links are signed with `SESSION_SECRET`. If you ever change that
secret, links in emails you've already sent stop working. People can still
use the contact form, and you can remove them by hand.

## Notes

- **Duplicates** are rejected automatically — the email column is the primary key,
  and the form shows the visitor a friendly "you're already on the list" message.
- **Privacy:** the list lives in your private Cloudflare database. It is not
  visible on the website and not accessible to other visitors.
- If email sending ever fails, the signup is still saved — no subscriber is lost.

## Publishing a blog post

The blog is now a full CMS — go to **jeffreypotts.ca/admin/blog**, log in
with `ADMIN_PASSWORD_BLOG`, and use the "New Post" form (title, HTML body,
optional image). New posts appear at the top of **/blog/** immediately —
no commit or deploy needed. Edit and Delete are on the same page, next to
each existing post.

The post body field accepts raw HTML (bold, links, paragraphs, etc.) —
whatever you type is rendered as-is on the post page.

## Using the download sections

Each of the three sections has two URLs:

- `jeffreypotts.ca/downloads/section-1` (and `section-2`, `section-3`) —
  the page you share with visitors. They enter `DOWNLOAD_PASSWORD_N` to see
  and download the files.
- `jeffreypotts.ca/admin/section-1` (etc.) — where you log in with
  `ADMIN_PASSWORD_N` to upload new files or delete old ones. Changes show
  up on the visitor page immediately.

Neither URL is linked from the site's navigation — they're only reachable
if you share the link directly, matching how you'd hand out a password.
The section labels ("Section 1", "Section 2", "Section 3") are placeholders
in `src/lib/downloads.js` — tell me what each section is actually for and
I'll rename them in one edit.

## Posting from MarsEdit

The blog also accepts posts from MarsEdit (or any editor that speaks the
MetaWeblog API). MarsEdit gets its own username and app password, separate
from `ADMIN_PASSWORD_BLOG`, so you can change it, or shut MarsEdit out,
without touching your web admin login. The app password can't unlock
`/admin/blog`.

**One-time setup:**

1. Cloudflare dashboard → your Worker → **Settings → Variables and
   Secrets** → add both as **Encrypt (secret)**, then **Save and deploy**:

   | Variable | Value |
   |---|---|
   | `BLOG_APP_USER` | The username you'll type into MarsEdit (e.g. `jeff`) |
   | `BLOG_APP_PASSWORD` | A long random password from your password manager. MarsEdit stores it in your Keychain, so you never need to type it again. |

2. In MarsEdit: **File → New Blog…** → name it, enter
   `https://jeffreypotts.ca/blog/` → **Continue**. It should find the blog
   on its own. If it asks, choose **System: MetaWeblog API** and
   **API Endpoint URL: `https://jeffreypotts.ca/xmlrpc`**.
3. Enter `BLOG_APP_USER` and `BLOG_APP_PASSWORD` when it asks.

**What works:** publishing, editing and deleting posts; downloading
existing posts into MarsEdit; images dragged into a post (uploaded to R2
and served from `/blog/media/`); setting a post's date; and editing the
slug (the address after `/blog/`). Posts published from MarsEdit and from
`/admin/blog` are the same posts. You can edit either way.

**Tags:** type them in MarsEdit's Tags field, or the Tags box on
`/admin/blog`, separated by commas. Each post shows its tags, and each tag
has a page listing its posts at `/blog/tag/<tag>`. Tags need the
`post_tags` table from `schema.sql`, which is safe to re-run.

**What doesn't:** categories (the blog has tags instead), and drafts
saved on the server. Keep drafts as local drafts in MarsEdit; choosing
"Send to Blog as Draft" gives an error rather than publishing by
accident.

Images you delete from a post stay in R2. They're small, and nothing
links to them.
