/**
 * Cloudflare Turnstile: checks the token a form sends before its handler runs.
 *
 * The token must pass siteverify, carry the form's action, and come from a
 * hostname in TURNSTILE_HOSTNAMES (comma-separated: set in wrangler.jsonc for
 * the live site, and in .dev.vars for local testing). Anything else —
 * missing token, missing config, siteverify unreachable — fails closed.
 *
 * TURNSTILE_SECRET is a Worker secret. Tokens are single-use, so the page
 * resets its widget after every submission attempt.
 */

// Public: the widget's sitekey, also hard-coded in index.html.
export const TURNSTILE_SITEKEY = "0x4AAAAAAFTX-6k4xMYiEYy3";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const TURNSTILE_FAILED_MESSAGE =
  "We couldn't confirm you're human. Please complete the check above the button again, then resend.";

export async function verifyTurnstile(env, request, token, expectedAction) {
  const expectedHostnames = new Set(
    String(env.TURNSTILE_HOSTNAMES || "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean)
  );
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 2048 ||
    !env.TURNSTILE_SECRET ||
    expectedHostnames.size === 0
  ) {
    return false;
  }

  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.set("remoteip", ip);

  let result;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    result = await res.json();
  } catch (e) {
    return false;
  }

  return (
    result.success === true &&
    result.action === expectedAction &&
    expectedHostnames.has(result.hostname)
  );
}
