/**
 * Posting from MarsEdit (or any other desktop blog editor that speaks the
 * MetaWeblog API):
 *
 *   POST  /xmlrpc   — the MetaWeblog XML-RPC endpoint
 *   GET   /rsd.xml  — Really Simple Discovery file, so MarsEdit can find
 *                     /xmlrpc from just the blog's address (pages link to
 *                     it with <link rel="EditURI">)
 *
 * Signs in with BLOG_APP_USER + BLOG_APP_PASSWORD — an app password kept
 * separate from ADMIN_PASSWORD_BLOG, so it can be changed (shutting
 * MarsEdit out) without touching the web admin login, and it can't be
 * used to log in to /admin/blog.
 *
 * Posts go into the same D1 posts table as /admin/blog. Images dropped
 * into a post are uploaded through metaWeblog.newMediaObject to R2 under
 * blog/media/ and served from /blog/media/:file (see blog.js).
 *
 * Tags come and go through MarsEdit's Tags field (mt_keywords, a
 * comma-separated string) and are stored by tags.js.
 *
 * Not supported: categories (always empty), and drafts kept on the
 * server — publish=false is refused, since the posts table has no
 * unpublished state. Drafts stay local in MarsEdit until published.
 *
 * Workers have no DOMParser, so this includes a small XML-RPC parser. It
 * handles every value type in the spec; it is not a general XML parser.
 */

import { checkPassword } from "./auth.js";
import { uniqueSlug } from "./blog.js";
import { parseTags, tagsToString, setPostTags, deletePostTags, tagsForPosts } from "./tags.js";

const BLOG_ID = "1";
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

class Fault extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- XML-RPC parsing ----------

// CDATA | processing instruction | comment | tag (close flag, name, self-close flag) | text
const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>|([^<]+)/g;

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e];
  });
}

function parseXml(xml) {
  const root = { name: "#root", children: [], text: "" };
  const stack = [root];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[3]) {
      if (m[2]) {
        if (stack.length < 2 || top.name !== m[3]) throw new Error("mismatched </" + m[3] + ">");
        stack.pop();
      } else {
        const node = { name: m[3], children: [], text: "" };
        top.children.push(node);
        if (!m[4]) stack.push(node);
      }
    } else if (m[5] !== undefined) {
      top.text += decodeEntities(m[5]);
    }
  }
  if (stack.length !== 1) throw new Error("unclosed <" + stack[stack.length - 1].name + ">");
  return root;
}

function child(node, name) {
  return node.children.find((c) => c.name === name);
}

function parseIsoDate(s) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return null;
  // No zone given means UTC — MarsEdit sends date_created_gmt alongside, and
  // that's the field read first (see postDate).
  let zone = m[7] || "Z";
  if (zone !== "Z" && !zone.includes(":")) zone = zone.slice(0, 3) + ":" + zone.slice(3);
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${zone}`);
  return isNaN(d) ? null : d;
}

function base64ToBytes(s) {
  const bin = atob(s.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeValue(valueNode) {
  const typed = valueNode.children[0];
  if (!typed) return valueNode.text; // untyped value is a string
  const t = typed.text;
  switch (typed.name) {
    case "string":
      return t;
    case "int":
    case "i4":
    case "i8":
      return parseInt(t.trim(), 10);
    case "double":
      return parseFloat(t.trim());
    case "boolean":
      return t.trim() === "1" || t.trim().toLowerCase() === "true";
    case "dateTime.iso8601":
      return parseIsoDate(t.trim());
    case "base64":
      return base64ToBytes(t);
    case "nil":
      return null;
    case "struct": {
      const out = {};
      for (const member of typed.children) {
        if (member.name !== "member") continue;
        const name = child(member, "name");
        const value = child(member, "value");
        if (name && value) out[name.text.trim()] = decodeValue(value);
      }
      return out;
    }
    case "array": {
      const data = child(typed, "data");
      return data ? data.children.filter((c) => c.name === "value").map(decodeValue) : [];
    }
    default:
      throw new Error("unknown type <" + typed.name + ">");
  }
}

function parseCall(xml) {
  const call = child(parseXml(xml), "methodCall");
  const methodName = call && child(call, "methodName");
  if (!methodName) throw new Error("not an XML-RPC methodCall");
  const params = child(call, "params");
  return {
    methodName: methodName.text.trim(),
    params: params
      ? params.children.filter((p) => p.name === "param").map((p) => {
          const v = child(p, "value");
          return v ? decodeValue(v) : null;
        })
      : [],
  };
}

// ---------- XML-RPC encoding ----------

function xmlEscape(s) {
  return String(s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isoBasic(d) {
  // XML-RPC's own dateTime format, in UTC: 20260929T17:38:00
  return d.toISOString().replace(/-/g, "").replace(/\.\d+Z$/, "");
}

function encodeValue(v) {
  if (v === null || v === undefined) return "<value><string></string></value>";
  if (typeof v === "boolean") return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "number") return Number.isInteger(v) ? `<value><int>${v}</int></value>` : `<value><double>${v}</double></value>`;
  if (v instanceof Date) return `<value><dateTime.iso8601>${isoBasic(v)}</dateTime.iso8601></value>`;
  if (Array.isArray(v)) return `<value><array><data>${v.map(encodeValue).join("")}</data></array></value>`;
  if (typeof v === "object") {
    const members = Object.entries(v).map(([k, x]) => `<member><name>${xmlEscape(k)}</name>${encodeValue(x)}</member>`);
    return `<value><struct>${members.join("")}</struct></value>`;
  }
  return `<value><string>${xmlEscape(v)}</string></value>`;
}

function xmlResponse(body) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function successResponse(value) {
  return xmlResponse(`<methodResponse><params><param>${encodeValue(value)}</param></params></methodResponse>`);
}

function faultResponse(code, message) {
  return xmlResponse(`<methodResponse><fault>${encodeValue({ faultCode: code, faultString: message })}</fault></methodResponse>`);
}

// ---------- helpers ----------

async function authenticate(ctx, username, password) {
  const { env } = ctx;
  if (!env.BLOG_APP_USER || !env.BLOG_APP_PASSWORD) {
    throw new Fault(403, "Posting from MarsEdit isn't set up yet: add the BLOG_APP_USER and BLOG_APP_PASSWORD secrets.");
  }
  const [userOk, passOk] = await Promise.all([
    checkPassword(String(username ?? ""), env.BLOG_APP_USER),
    checkPassword(String(password ?? ""), env.BLOG_APP_PASSWORD),
  ]);
  if (!userOk || !passOk) throw new Fault(403, "Incorrect username or password.");
}

function str(v) {
  return v === null || v === undefined ? "" : String(v);
}

function requirePublish(publish, content) {
  if (publish === false || (content && str(content.post_status) === "draft")) {
    throw new Fault(400, "This blog doesn't keep drafts on the server. Keep it as a local draft in MarsEdit, and publish when it's ready.");
  }
}

function postBody(content) {
  const more = str(content.mt_text_more);
  return str(content.description) + (more.trim() ? "\n\n" + more : "");
}

function postDate(content) {
  const d = content.date_created_gmt || content.dateCreated;
  return d instanceof Date && !isNaN(d) ? d : null;
}

function postStruct(post, ctx, tags) {
  const link = `${ctx.origin}/blog/${post.slug}`;
  return {
    postid: post.id,
    title: post.title,
    description: post.body_html,
    link,
    permaLink: link,
    dateCreated: new Date(post.created_at),
    date_created_gmt: new Date(post.created_at),
    date_modified_gmt: new Date(post.updated_at),
    wp_slug: post.slug,
    userid: "1",
    post_status: "publish",
    categories: [],
    mt_keywords: tagsToString(tags),
    mt_excerpt: "",
    mt_text_more: "",
    mt_allow_comments: 0,
    mt_allow_pings: 0,
  };
}

async function loadPost(ctx, postId) {
  const post = await ctx.env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(str(postId)).first();
  if (!post) throw new Fault(404, "That post doesn't exist on the blog any more.");
  return post;
}

function blogInfo(ctx) {
  return {
    blogid: BLOG_ID,
    blogName: ctx.blogName,
    url: `${ctx.origin}/blog/`,
    xmlrpc: `${ctx.origin}/xmlrpc`,
    isAdmin: true,
  };
}

function mediaFileName(name) {
  const base = str(name).split("/").pop() || "image";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(-100) || "image";
}

// ---------- methods ----------

const METHODS = {
  async "blogger.getUsersBlogs"([, user, pass], ctx) {
    await authenticate(ctx, user, pass);
    return [blogInfo(ctx)];
  },

  async "metaWeblog.getUsersBlogs"([user, pass], ctx) {
    await authenticate(ctx, user, pass);
    return [blogInfo(ctx)];
  },

  async "blogger.getUserInfo"([, user, pass], ctx) {
    await authenticate(ctx, user, pass);
    return { userid: "1", nickname: str(user), firstname: "", lastname: "", email: "", url: ctx.origin };
  },

  async "metaWeblog.getRecentPosts"([, user, pass, count], ctx) {
    await authenticate(ctx, user, pass);
    const limit = Math.min(Math.max(parseInt(count, 10) || 20, 1), 500);
    const { results } = await ctx.env.DB.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT ?").bind(limit).all();
    const tags = await tagsForPosts(ctx.env, results.map((p) => p.id));
    return results.map((p) => postStruct(p, ctx, tags.get(p.id)));
  },

  async "metaWeblog.getPost"([postId, user, pass], ctx) {
    await authenticate(ctx, user, pass);
    const post = await loadPost(ctx, postId);
    const tags = await tagsForPosts(ctx.env, [post.id]);
    return postStruct(post, ctx, tags.get(post.id));
  },

  async "metaWeblog.newPost"([, user, pass, content, publish], ctx) {
    await authenticate(ctx, user, pass);
    content = content || {};
    requirePublish(publish, content);
    const title = str(content.title).trim();
    const body = postBody(content);
    if (!title) throw new Fault(400, "A post needs a title.");
    if (!body.trim()) throw new Fault(400, "A post needs some text.");

    const id = crypto.randomUUID();
    const slug = await uniqueSlug(ctx.env, str(content.wp_slug).trim() || title);
    const now = new Date().toISOString();
    const created = (postDate(content) || new Date()).toISOString();
    await ctx.env.DB
      .prepare("INSERT INTO posts (id, slug, title, body_html, image_key, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)")
      .bind(id, slug, title, body, created, now)
      .run();
    const tags = parseTags(content.mt_keywords);
    if (tags.length) await setPostTags(ctx.env, id, tags);
    return id;
  },

  async "metaWeblog.editPost"([postId, user, pass, content, publish], ctx) {
    await authenticate(ctx, user, pass);
    content = content || {};
    requirePublish(publish, content);
    const post = await loadPost(ctx, postId);
    const title = str(content.title).trim() || post.title;
    const body = postBody(content).trim() ? postBody(content) : post.body_html;

    // An explicit slug from MarsEdit wins (it sends back the one we gave it,
    // so links stay put when only the title changes). Without one, follow
    // /admin/blog: a new title gets a new slug.
    const wantedSlug = str(content.wp_slug).trim();
    let slug = post.slug;
    if (wantedSlug) {
      if (wantedSlug !== post.slug) slug = await uniqueSlug(ctx.env, wantedSlug, post.id);
    } else if (title !== post.title) {
      slug = await uniqueSlug(ctx.env, title, post.id);
    }
    const created = (postDate(content) || new Date(post.created_at)).toISOString();

    await ctx.env.DB
      .prepare("UPDATE posts SET title = ?, slug = ?, body_html = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .bind(title, slug, body, created, new Date().toISOString(), post.id)
      .run();
    // Only touch tags when MarsEdit sent the field; an empty string clears them.
    if (Object.prototype.hasOwnProperty.call(content, "mt_keywords")) {
      await setPostTags(ctx.env, post.id, parseTags(content.mt_keywords));
    }
    return true;
  },

  async "blogger.deletePost"([, postId, user, pass], ctx) {
    await authenticate(ctx, user, pass);
    const post = await loadPost(ctx, postId);
    if (post.image_key) await ctx.bucket.delete(post.image_key);
    await ctx.env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(post.id).run();
    await deletePostTags(ctx.env, post.id);
    return true;
  },

  async "mt.publishPost"([postId, user, pass], ctx) {
    await authenticate(ctx, user, pass);
    await loadPost(ctx, postId);
    return true; // every post is already published
  },

  async "metaWeblog.newMediaObject"([, user, pass, file], ctx) {
    await authenticate(ctx, user, pass);
    file = file || {};
    const bits = file.bits;
    const type = str(file.type).toLowerCase();
    if (!(bits instanceof Uint8Array) || !bits.length) throw new Fault(400, "No file data was sent.");
    if (!type.startsWith("image/")) throw new Fault(415, "Only images can be uploaded to this blog.");
    if (bits.length > MAX_MEDIA_BYTES) throw new Fault(413, "That image is over 25 MB.");

    const fileName = `${crypto.randomUUID().slice(0, 8)}-${mediaFileName(file.name)}`;
    await ctx.bucket.put(`blog/media/${fileName}`, bits, { httpMetadata: { contentType: type } });
    const url = `${ctx.origin}/blog/media/${fileName}`;
    return { url, file: fileName, type };
  },

  // No categories — answer the questions MarsEdit asks with "none". (Tags
  // travel in mt_keywords instead.)
  async "metaWeblog.getCategories"([, user, pass], ctx) {
    await authenticate(ctx, user, pass);
    return [];
  },
  async "mt.getCategoryList"([, user, pass], ctx) {
    await authenticate(ctx, user, pass);
    return [];
  },
  async "mt.getPostCategories"([, user, pass], ctx) {
    await authenticate(ctx, user, pass);
    return [];
  },
  async "mt.setPostCategories"([, user, pass], ctx) {
    await authenticate(ctx, user, pass);
    return true;
  },
  async "mt.supportedTextFilters"() {
    return [];
  },
  async "mt.supportedMethods"() {
    return Object.keys(METHODS);
  },
};

function rsdXml(ctx) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rsd version="1.0" xmlns="http://archipelago.phrasewise.com/rsd">
  <service>
    <engineName>${xmlEscape(ctx.blogName)}</engineName>
    <engineLink>${ctx.origin}/</engineLink>
    <homePageLink>${ctx.origin}/blog/</homePageLink>
    <apis>
      <api name="MetaWeblog" preferred="true" apiLink="${ctx.origin}/xmlrpc" blogID="${BLOG_ID}" />
    </apis>
  </service>
</rsd>`;
}

/**
 * Returns a Response for /xmlrpc and /rsd.xml, or null for any other path.
 * `bucket` is the R2 bucket that holds blog images.
 */
export async function handleXmlRpcRequest(request, env, url, { blogName, bucket }) {
  const ctx = { env, bucket, blogName, origin: url.origin };

  if (url.pathname === "/rsd.xml" && (request.method === "GET" || request.method === "HEAD")) {
    return new Response(request.method === "HEAD" ? null : rsdXml(ctx), {
      headers: { "Content-Type": "application/rsd+xml; charset=utf-8" },
    });
  }
  if (url.pathname !== "/xmlrpc") return null;
  if (request.method !== "POST") {
    return new Response("XML-RPC server accepts POST requests only.", { status: 405, headers: { Allow: "POST" } });
  }

  let call;
  try {
    call = parseCall(await request.text());
  } catch (e) {
    return faultResponse(-32700, "Couldn't read the request: " + e.message);
  }
  const method = Object.prototype.hasOwnProperty.call(METHODS, call.methodName) ? METHODS[call.methodName] : null;
  if (!method) return faultResponse(-32601, `This blog doesn't support ${call.methodName}.`);

  try {
    return successResponse(await method(call.params, ctx));
  } catch (e) {
    if (e instanceof Fault) return faultResponse(e.code, e.message);
    console.error("xmlrpc", call.methodName, "failed:", e && e.stack);
    return faultResponse(500, "Something went wrong on the server. Please try again.");
  }
}
