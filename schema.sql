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
