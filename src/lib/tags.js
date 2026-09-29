/**
 * Post tags, stored in the D1 post_tags table (see schema.sql): one row
 * per post per tag, keyed by the tag's URL slug, keeping the name as it
 * was typed for display. Tags come in as one comma-separated string —
 * the /admin/blog form field, and MarsEdit's Tags field (mt_keywords).
 */

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;

export function tagSlug(name) {
  return String(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** "Writing, craft ,writing" → [{ slug: "writing", name: "Writing" }, { slug: "craft", name: "craft" }] */
export function parseTags(input) {
  const seen = new Set();
  const tags = [];
  for (const raw of String(input || "").split(",")) {
    const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH);
    const slug = tagSlug(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    tags.push({ slug, name });
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

export function tagsToString(tags) {
  return (tags || []).map((t) => t.name).join(", ");
}

/** Replaces a post's tags with `tags` (from parseTags). */
export async function setPostTags(env, postId, tags) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM post_tags WHERE post_id = ?").bind(postId),
    ...tags.map((t) => env.DB.prepare("INSERT INTO post_tags (post_id, slug, name) VALUES (?, ?, ?)").bind(postId, t.slug, t.name)),
  ]);
}

export async function deletePostTags(env, postId) {
  await env.DB.prepare("DELETE FROM post_tags WHERE post_id = ?").bind(postId).run();
}

/** Map of post id → [{ slug, name }], for the given post ids. */
export async function tagsForPosts(env, postIds) {
  const byPost = new Map(postIds.map((id) => [id, []]));
  // D1 caps bound parameters per statement, so ask in chunks.
  for (let i = 0; i < postIds.length; i += 90) {
    const chunk = postIds.slice(i, i + 90);
    const { results } = await env.DB
      .prepare(`SELECT post_id, slug, name FROM post_tags WHERE post_id IN (${chunk.map(() => "?").join(",")}) ORDER BY rowid`)
      .bind(...chunk)
      .all();
    for (const r of results) byPost.get(r.post_id).push({ slug: r.slug, name: r.name });
  }
  return byPost;
}
