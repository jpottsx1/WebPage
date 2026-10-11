/**
 * Alt text for blog header images, kept in its own table (post_image_alt in
 * schema.sql) so schema.sql stays safe to re-run. An empty description means
 * the image is decorative, and the page gives it alt="".
 *
 * Reads and writes never throw: if the table is missing, posts still render
 * (with alt="") and still save.
 */

const MAX_ALT = 300;

export function cleanAlt(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_ALT);
}

export async function getImageAlt(env, postId) {
  try {
    const row = await env.DB.prepare("SELECT alt FROM post_image_alt WHERE post_id = ?").bind(postId).first();
    return row ? row.alt : "";
  } catch (e) {
    return "";
  }
}

export async function setImageAlt(env, postId, value) {
  const alt = cleanAlt(value);
  try {
    if (!alt) {
      await env.DB.prepare("DELETE FROM post_image_alt WHERE post_id = ?").bind(postId).run();
    } else {
      await env.DB
        .prepare("INSERT INTO post_image_alt (post_id, alt) VALUES (?, ?) ON CONFLICT(post_id) DO UPDATE SET alt = excluded.alt")
        .bind(postId, alt)
        .run();
    }
  } catch (e) {
    /* table missing: the post still saves */
  }
}

export async function deleteImageAlt(env, postId) {
  await setImageAlt(env, postId, "");
}
