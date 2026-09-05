/**
 * Resend transport.
 *
 * Uses the REST API over `fetch` rather than the `resend` npm SDK: the SDK is a
 * thin wrapper over this one endpoint, and skipping it keeps the Worker at zero
 * runtime dependencies and well inside the free-tier bundle size.
 *
 * https://resend.com/docs/api-reference/emails/send-email
 */
import type { Env } from "./env";
import { escapeHtml } from "./validate";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Resend's own guidance is to give up rather than hang; the caller retries. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface SendResult {
  ok: boolean;
  id?: string;
  status?: number;
  error?: string;
}

interface ResendPayload {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  reply_to?: string[];
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
}

async function send(
  env: Env,
  payload: ResendPayload,
  idempotencyKey?: string,
): Promise<SendResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Read the body so the failure is diagnosable in Workers Logs. It never
      // reaches the visitor.
      const detail = await response.text().catch(() => "");
      return { ok: false, status: response.status, error: detail.slice(0, 500) };
    }

    const body = (await response.json().catch(() => ({}))) as { id?: string };
    return { ok: true, ...(body.id ? { id: body.id } : {}) };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Stable per address per day, so a double-click cannot mail the team twice. */
export async function idempotencyKey(email: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const bytes = new TextEncoder().encode(`waitlist:${email}:${day}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface SignupContext {
  email: string;
  source: string;
  country: string;
  userAgent: string;
  receivedAt: string;
}

/** The email that lands in the team inbox. Reply-To is the signup itself. */
export async function sendNotification(env: Env, ctx: SignupContext): Promise<SendResult> {
  const safe = {
    email: escapeHtml(ctx.email),
    source: escapeHtml(ctx.source),
    country: escapeHtml(ctx.country),
    userAgent: escapeHtml(ctx.userAgent),
    receivedAt: escapeHtml(ctx.receivedAt),
  };

  const text = [
    `New ${env.BRAND_NAME} waitlist signup`,
    "",
    `Email:    ${ctx.email}`,
    `Form:     ${ctx.source}`,
    `Country:  ${ctx.country}`,
    `Received: ${ctx.receivedAt}`,
    `Agent:    ${ctx.userAgent}`,
    "",
    "Reply directly to this email to reach them.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;background:#f5f0e6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#191915">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e6;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffdf8;border:2px solid #191915">
        <tr><td style="background:#191915;color:#f5f0e6;padding:14px 22px;font:700 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.15em">NEW WAITLIST SIGNUP</td></tr>
        <tr><td style="padding:26px 24px">
          <p style="margin:0 0 4px;font:700 10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.13em;color:rgba(25,25,21,.68)">EMAIL</p>
          <p style="margin:0 0 22px;font-size:20px;font-weight:700"><a href="mailto:${safe.email}" style="color:#0f5c5a;text-decoration:underline">${safe.email}</a></p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid rgba(25,25,21,.22);font:12px/2 ui-monospace,SFMono-Regular,Menlo,monospace;color:#4a4a43">
            <tr><td style="padding-top:14px;width:88px">FORM</td><td style="padding-top:14px">${safe.source}</td></tr>
            <tr><td>COUNTRY</td><td>${safe.country}</td></tr>
            <tr><td>RECEIVED</td><td>${safe.receivedAt}</td></tr>
            <tr><td style="vertical-align:top">AGENT</td><td style="word-break:break-word">${safe.userAgent}</td></tr>
          </table>
          <p style="margin:22px 0 0;padding-top:16px;border-top:1px solid rgba(25,25,21,.22);font-size:14px;color:#4a4a43">Reply to this email to reach them directly.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return send(
    env,
    {
      from: env.FROM_ADDRESS,
      to: [env.NOTIFY_TO],
      reply_to: [ctx.email],
      subject: `Waitlist: ${ctx.email}`,
      text,
      html,
      tags: [{ name: "type", value: "waitlist_notification" }],
    },
    await idempotencyKey(ctx.email),
  );
}

/**
 * The confirmation the page promises ("reply to the confirmation email"). Sent
 * on a best-effort basis — see `handleWaitlist`, which never fails the request
 * because of it.
 */
export async function sendConfirmation(env: Env, email: string): Promise<SendResult> {
  const text = [
    "You’re on the list.",
    "",
    "While you wait, one question — and a real answer helps us more than a",
    "signup does: which assumption about your customer are you least sure",
    "about?",
    "",
    "Just reply to this email. A person reads every one.",
    "",
    `— ${env.BRAND_NAME}`,
    env.SITE_ORIGIN,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;background:#f5f0e6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#191915">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e6;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffdf8;border:2px solid #191915">
        <tr><td style="padding:30px 28px">
          <p style="margin:0;font:900 22px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:-.05em">UN<span style="font-weight:400">ASSUMED</span><span style="color:#c62a20">.</span></p>
          <h1 style="margin:26px 0 0;font-size:28px;line-height:1.2;font-weight:800">You’re on the list.</h1>
          <p style="margin:18px 0 0;font-size:16px;line-height:1.6;color:#4a4a43">While you wait, one question — and a real answer helps us more than a signup does:</p>
          <p style="margin:18px 0 0;padding:16px 18px;background:#f5f0e6;border-left:5px solid #ffe24d;font-size:17px;line-height:1.5;font-weight:700">Which assumption about your customer are you least sure about?</p>
          <p style="margin:18px 0 0;font-size:16px;line-height:1.6;color:#4a4a43">Just reply to this email. A person reads every one.</p>
          <p style="margin:26px 0 0;padding-top:18px;border-top:1px solid rgba(25,25,21,.22);font:11px/1.8 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;color:rgba(25,25,21,.68)">
            BUILT FOR EVIDENCE, NOT APPLAUSE.<br>
            You are receiving this because you asked for early access at <a href="${env.SITE_ORIGIN}" style="color:#0f5c5a">${escapeHtml(env.SITE_ORIGIN)}</a>. Reply “remove” and you are off the list.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return send(env, {
    from: env.FROM_ADDRESS,
    to: [email],
    reply_to: [env.NOTIFY_TO],
    subject: `You’re on the ${env.BRAND_NAME} list`,
    text,
    html,
    tags: [{ name: "type", value: "waitlist_confirmation" }],
  });
}
