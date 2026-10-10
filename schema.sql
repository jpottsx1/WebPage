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

-- Files behind the three password-protected download sections.
CREATE TABLE IF NOT EXISTS download_files (
  id          TEXT PRIMARY KEY,
  section     TEXT NOT NULL,        -- 'section-1' | 'section-2' | 'section-3'
  filename    TEXT NOT NULL,        -- original name shown to visitors
  r2_key      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_download_files_section
  ON download_files (section, uploaded_at);

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
