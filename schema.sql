-- D1 schema for the newsletter subscriber list.
-- Apply once with:
--   npx wrangler d1 execute jeffreypotts-newsletter --remote --file=schema.sql
-- (or run the CREATE TABLE statement in the D1 console in the Cloudflare dashboard)

CREATE TABLE IF NOT EXISTS subscribers (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscribers_created_at
  ON subscribers (created_at);


-- Blog posts (managed from /admin/blog).
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  body_html   TEXT NOT NULL,
  image_key   TEXT,                 -- optional R2 key for a header image
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_created_at
  ON posts (created_at);

-- Blog post tags: one row per post per tag. slug is the URL form
-- (/blog/tag/<slug>); name is the tag as it was typed.
CREATE TABLE IF NOT EXISTS post_tags (
  post_id  TEXT NOT NULL,
  slug     TEXT NOT NULL,
  name     TEXT NOT NULL,
  PRIMARY KEY (post_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_post_tags_slug
  ON post_tags (slug);

-- Newsletters sent from /admin/newsletter (history + double-send guard).
CREATE TABLE IF NOT EXISTS newsletters (
  id              TEXT PRIMARY KEY,
  subject         TEXT NOT NULL,
  body_html       TEXT NOT NULL,
  sent_at         TEXT NOT NULL,
  recipient_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_newsletters_sent_at
  ON newsletters (sent_at);

-- Rate limiting (src/lib/ratelimit.js): one row per wrong password or form
-- submission, keyed like "auth:<ip>". Rows older than a day are deleted.
CREATE TABLE IF NOT EXISTS rate_events (
  key TEXT NOT NULL,
  at  INTEGER NOT NULL           -- milliseconds since 1970
);

CREATE INDEX IF NOT EXISTS idx_rate_events_key_at
  ON rate_events (key, at);

CREATE INDEX IF NOT EXISTS idx_rate_events_at
  ON rate_events (at);

-- Alt text for blog header images (src/lib/imagealt.js). A separate table
-- rather than a new posts column, so this file stays safe to re-run.
CREATE TABLE IF NOT EXISTS post_image_alt (
  post_id TEXT PRIMARY KEY,
  alt     TEXT NOT NULL
);

-- Draft blog posts (src/lib/publishing.js): a post listed here is hidden from
-- readers. Scheduled posts need no table: a created_at in the future keeps a
-- post hidden until then.
CREATE TABLE IF NOT EXISTS post_drafts (
  post_id TEXT PRIMARY KEY
);

-- Newsletters shown in the public archive at /newsletter (src/lib/newsletter.js).
-- Off unless listed here: issues can carry subscriber-only early chapters.
CREATE TABLE IF NOT EXISTS newsletter_public (
  newsletter_id TEXT PRIMARY KEY
);

-- Double opt-in (src/lib/optin.js): sign-ups waiting for the confirmation
-- link. Cleared after 7 days by the daily scheduled job.
CREATE TABLE IF NOT EXISTS pending_subscribers (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Saved newsletter drafts (/admin/newsletter).
CREATE TABLE IF NOT EXISTS email_drafts (
  id         TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  body_html  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- "Tell me when it's out" (src/lib/bookalerts.js): one row per person per
-- book. confirmed_at is NULL until the confirmation link is used; unconfirmed
-- rows are cleared after 7 days, and a book's rows once its email is sent.
CREATE TABLE IF NOT EXISTS book_alerts (
  email        TEXT NOT NULL,
  book_slug    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  confirmed_at TEXT,
  PRIMARY KEY (email, book_slug)
);

-- Release emails sent from /admin/book-alerts (history + double-send guard).
CREATE TABLE IF NOT EXISTS book_alert_sends (
  id              TEXT PRIMARY KEY,
  book_slug       TEXT NOT NULL,
  subject         TEXT NOT NULL,
  sent_at         TEXT NOT NULL,
  recipient_count INTEGER NOT NULL
);
