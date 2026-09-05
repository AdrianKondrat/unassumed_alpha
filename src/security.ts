/**
 * Request-side checks and response headers for Worker-generated responses.
 *
 * Static assets get their headers from `public/_headers` (see scripts/build.mjs).
 * The two policies are deliberately separate: the Worker returns only JSON and
 * one dependency-free HTML page, so it can run a far tighter CSP than the site.
 */
import type { Env } from "./env";

/** Applies to every Worker response. */
const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=(), interest-cohort=()",
  // Never cache a form response, in any shared cache or any browser.
  "Cache-Control": "no-store",
};

/** Nothing the Worker emits loads a script, an image or a font. */
const WORKER_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Security-Policy": WORKER_CSP,
    },
  });
}

export function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": WORKER_CSP,
    },
  });
}

export function redirectResponse(location: string): Response {
  // 303 so the browser follows with GET and a reload cannot re-post the form.
  return new Response(null, {
    status: 303,
    headers: { ...BASE_HEADERS, Location: location },
  });
}

/**
 * Rejects cross-site form posts. There is no CORS header anywhere in this
 * Worker, so a browser cannot read the response cross-origin, but it can still
 * *send* a simple POST — this is what stops that being useful.
 *
 * `localhost` and `127.0.0.1` are allowed so `wrangler dev` works.
 */
export function isTrustedOrigin(request: Request, env: Env): boolean {
  const stated = request.headers.get("Origin") ?? request.headers.get("Referer");
  // A same-origin form post from a very old browser may send neither. Falling
  // back to the request's own origin keeps those working.
  if (!stated) return true;

  let host: string;
  try {
    host = new URL(stated).origin;
  } catch {
    return false;
  }

  if (host === env.SITE_ORIGIN) return true;
  if (host === new URL(request.url).origin) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

/**
 * Verifies a Cloudflare Turnstile token. Returns `true` when Turnstile is not
 * configured, so the endpoint works before the widget is added to the form and
 * hardens the moment `TURNSTILE_SECRET_KEY` is set.
 */
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  ip: string,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);

  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body, signal: AbortSignal.timeout(8_000) },
    );
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch (cause) {
    console.error("turnstile_verify_failed", cause);
    return false;
  }
}
