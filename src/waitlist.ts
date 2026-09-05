/**
 * POST /api/waitlist
 *
 * Accepts both `application/json` (the fetch path, when JS is running) and
 * `application/x-www-form-urlencoded` (a plain HTML form submit, when it is
 * not). The no-JS path is not a courtesy — it is the difference between a
 * signup that survives a failed script load and one that vanishes.
 */
import type { Env } from "./env";
import { parseEmail } from "./validate";
import { sendConfirmation, sendNotification } from "./email";
import { markSent, storeSignup } from "./storage";
import {
  htmlResponse,
  isTrustedOrigin,
  jsonResponse,
  redirectResponse,
  verifyTurnstile,
} from "./security";

/** Nothing legitimate posted to this endpoint is anywhere near this large. */
const MAX_BODY_BYTES = 4_096;

/** Hidden field. A human never sees it; most bots fill everything in. */
const HONEYPOT_FIELD = "company";

interface Submission {
  email: unknown;
  honeypot: string;
  source: string;
  turnstileToken: string | undefined;
}

async function readSubmission(request: Request): Promise<Submission | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return null;

  const contentType = request.headers.get("Content-Type") ?? "";

  let fields: Record<string, unknown>;
  if (contentType.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return null;
      fields = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  } else {
    fields = Object.fromEntries(new URLSearchParams(raw));
  }

  const asString = (value: unknown): string => (typeof value === "string" ? value : "");

  return {
    email: fields["email"],
    honeypot: asString(fields[HONEYPOT_FIELD]),
    source: asString(fields["source"]).slice(0, 40) || "unknown",
    turnstileToken: asString(fields["cf-turnstile-response"]) || undefined,
  };
}

/** A minimal, self-contained page for the no-JS failure path. */
function errorPage(env: Env, message: string, status: number): Response {
  const safe = message.replace(/</g, "&lt;");
  return htmlResponse(
    `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>That didn’t go through — ${env.BRAND_NAME}</title>
<link rel="stylesheet" href="/styles.css"></head>
<body class="mini"><main class="mini-card">
<p class="slabel">SIGNUP FAILED</p>
<h1 class="disp">That didn’t go through.</h1>
<p class="body">${safe}</p>
<p><a class="mini-back" href="/#waitlist">← Back to the form</a></p>
</main></body></html>`,
    status,
  );
}

export async function handleWaitlist(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // `Accept` is set by our fetch call; a browser form submit never sends it.
  const wantsJson = (request.headers.get("Accept") ?? "").includes("application/json");
  const fail = (message: string, status: number): Response =>
    wantsJson
      ? jsonResponse({ ok: false, message }, status)
      : errorPage(env, message, status);

  if (!isTrustedOrigin(request, env)) {
    return fail("This form can only be submitted from the site itself.", 403);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "";

  // Guard the Resend quota before doing any work. `limit` is per Cloudflare
  // location, which is the right granularity here: an attacker spread across
  // colos is spread across the world, and a real visitor is not.
  if (env.WAITLIST_LIMITER && ip) {
    const { success } = await env.WAITLIST_LIMITER.limit({ key: `waitlist:${ip}` });
    if (!success) {
      return fail("Too many attempts. Give it a minute and try again.", 429);
    }
  }

  const submission = await readSubmission(request);
  if (!submission) {
    return fail("We couldn’t read that submission.", 400);
  }

  // A filled honeypot is a bot. Return the success shape so it learns nothing,
  // and send no email.
  if (submission.honeypot.trim() !== "") {
    return wantsJson
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(`${new URL(request.url).origin}/thanks`);
  }

  const parsed = parseEmail(submission.email);
  if (!parsed.ok) {
    return fail(parsed.message, 400);
  }

  if (!(await verifyTurnstile(env, submission.turnstileToken, ip))) {
    return fail("We couldn’t verify that you’re human. Reload the page and try again.", 403);
  }

  const record = {
    email: parsed.email,
    source: submission.source,
    country: (request as { cf?: { country?: string } }).cf?.country ?? "unknown",
    userAgent: (request.headers.get("User-Agent") ?? "unknown").slice(0, 200),
    receivedAt: new Date().toISOString(),
  };

  const succeed = (): Response =>
    wantsJson
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(`${new URL(request.url).origin}/thanks`);

  // Write the row first. From here on, an email provider outage costs a
  // notification — recoverable with `SELECT ... WHERE notified_at IS NULL` —
  // rather than the signup itself, which is recoverable from nowhere.
  const stored = await storeSignup(env.DB, record);

  // Already on the list. Say yes and send nothing: re-notifying the team is
  // noise, and re-sending the confirmation on demand would turn the form into
  // a way to mail-bomb somebody else's inbox.
  if (stored.status === "duplicate") {
    return succeed();
  }

  const notification = await sendNotification(env, record);

  if (notification.ok) {
    if (stored.status === "created") {
      ctx.waitUntil(markSent(env.DB, stored.id, "notified_at"));
    }
  } else {
    console.error("resend_notification_failed", {
      status: notification.status,
      error: notification.error,
      email: parsed.email,
      persisted: stored.status === "created",
    });

    // Only an error if the signup is nowhere at all. If the row was written,
    // the address is safe and telling the visitor otherwise would lose a
    // conversion over a problem that is entirely ours.
    if (stored.status !== "created") {
      return fail(
        `Something broke on our side, not yours. Try again in a moment, or email ${env.WAITLIST_NOTIFICATION_TO}.`,
        502,
      );
    }
  }

  // Best effort. The signup is already safe, so a failed confirmation must
  // never turn a successful signup into an error.
  if (env.SEND_CONFIRMATION === "true") {
    ctx.waitUntil(
      sendConfirmation(env, parsed.email).then((result) => {
        if (result.ok) {
          if (stored.status === "created") return markSent(env.DB, stored.id, "confirmed_at");
          return undefined;
        }
        console.error("resend_confirmation_failed", {
          status: result.status,
          error: result.error,
        });
        return undefined;
      }),
    );
  }

  return succeed();
}
