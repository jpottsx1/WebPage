# Newsletter backend — one-time setup

Your site already runs on Cloudflare Pages (deployed from GitHub). This adds a
backend that stores subscribers and sends a welcome email — all on Cloudflare's
free tier, with GitHub still in charge of deploys. You do **not** need to move
your domain off Namecheap.

The code is already in the repo:
- `functions/api/subscribe.js` — the backend function (runs at `/api/subscribe`)
- `schema.sql` — the database table
- The signup form posts to it automatically.

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

## 2. Bind the database to your Pages project

1. Cloudflare dashboard → **Workers & Pages** → your site → **Settings → Functions**.
2. Under **D1 database bindings** → **Add binding**.
   - Variable name: **`DB`** (exactly this)
   - D1 database: **jeffreypotts-newsletter**
3. Save.

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

## 4. Add the secrets to your Pages project

Cloudflare dashboard → your site → **Settings → Environment variables**
(Production) → add these three, then **Save** and **redeploy**:

| Variable | Value | Type |
|---|---|---|
| `RESEND_API_KEY` | your `re_...` key | **Encrypt** (secret) |
| `FROM_EMAIL` | `Jeffrey Potts <me@jeffreypotts.ca>` | Text |
| `NOTIFY_EMAIL` | `me@jeffreypotts.ca` (optional — alerts you on each signup) | Text |

## 5. Deploy and test

1. Push (already done) → Cloudflare Pages redeploys automatically with the function.
2. Go to your live site, sign up with your own email.
3. You should get the welcome email, and the subscriber should appear in D1.

---

## Where's my list? / Exporting to Excel

Your subscribers live in the D1 database. To see or export them:

- **Cloudflare dashboard → D1 → jeffreypotts-newsletter → Console**, run:

  ```sql
  SELECT name, email, created_at FROM subscribers ORDER BY created_at DESC;
  ```

- To download as CSV for Excel (needs the free `wrangler` CLI once,
  `npm install -g wrangler` then `wrangler login`):

  ```bash
  wrangler d1 execute jeffreypotts-newsletter --remote \
    --command "SELECT name, email, created_at FROM subscribers ORDER BY created_at DESC" \
    --json > subscribers.json
  ```

  (Ask me anytime and I can turn that into a one-click CSV export page.)

## Notes

- **Duplicates** are rejected automatically — the email column is the primary key,
  and the form shows the visitor a friendly "you're already on the list" message.
- **Privacy:** the list lives in your private Cloudflare database. It is not
  visible on the website and not accessible to other visitors.
- If email sending ever fails, the signup is still saved — no subscriber is lost.
