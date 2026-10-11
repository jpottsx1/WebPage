/**
 * Which posts readers can see.
 *
 *   draft      — listed in post_drafts. Never public; the admin can preview it.
 *   scheduled  — created_at is in the future. Goes public on its own at that
 *                moment; created_at is also the date the post shows.
 *   published  — everything else.
 *
 * Every public query (blog list, tag pages, single posts, older/newer links,
 * the feed, the sitemap) filters with publishedSql(). post_drafts is in
 * schema.sql; it must exist before this code is deployed.
 */

export function nowIso() {
  return new Date().toISOString();
}

/** SQL condition for "readers can see this post". Bind nowIso() for the ?. */
export function publishedSql(alias = "posts") {
  return `${alias}.created_at <= ? AND ${alias}.id NOT IN (SELECT post_id FROM post_drafts)`;
}

export async function draftIdSet(env, ids) {
  if (!ids.length) return new Set();
  const { results } = await env.DB
    .prepare(`SELECT post_id FROM post_drafts WHERE post_id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all();
  return new Set(results.map((r) => r.post_id));
}

export async function isDraft(env, postId) {
  return (await draftIdSet(env, [postId])).has(postId);
}

export async function setDraft(env, postId, draft) {
  if (draft) {
    await env.DB.prepare("INSERT OR IGNORE INTO post_drafts (post_id) VALUES (?)").bind(postId).run();
  } else {
    await env.DB.prepare("DELETE FROM post_drafts WHERE post_id = ?").bind(postId).run();
  }
}

export function postState(post, draft) {
  if (draft) return "draft";
  if (post.created_at > nowIso()) return "scheduled";
  return "published";
}

/**
 * The admin form's status choice, turned into what to store. `current` is
 * the post as it is now (null for a new post).
 *   publish   — public now. A draft or scheduled post gets today's date; an
 *               already-published post keeps its date.
 *   draft     — hidden; keeps its date (a new post gets now).
 *   schedule  — public at `publishAt` (an ISO time from the form).
 */
export function resolveStatus({ status, publishAt, current, currentDraft }) {
  const now = nowIso();
  if (status === "draft") {
    return { draft: true, createdAt: current ? current.created_at : now };
  }
  if (status === "schedule") {
    const t = new Date(String(publishAt || ""));
    if (!isNaN(t)) return { draft: false, createdAt: t.toISOString() };
    // No usable time: publish now rather than lose the choice silently.
  }
  const wasPublic = current && !currentDraft && current.created_at <= now;
  return { draft: false, createdAt: wasPublic ? current.created_at : now };
}
