/**
 * Input validation for the waitlist endpoint.
 *
 * Deliberately hand-rolled rather than pulled from npm: this is one field, the
 * rules fit on a screen, and a zero-dependency Worker has no supply chain to
 * audit and nothing to keep patched.
 */

/** RFC 5321 caps the whole address at 254 and the local part at 64. */
const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;

/**
 * Pragmatic, not RFC-complete. It rejects the mistakes people actually make
 * (missing @, trailing comma, a stray space, no TLD) and accepts everything a
 * real mailbox looks like. The authoritative check is the confirmation email
 * arriving — no regex can tell you an address is deliverable.
 */
const EMAIL_RE =
  /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

export type EmailResult =
  | { ok: true; email: string }
  | { ok: false; message: string };

export function parseEmail(raw: unknown): EmailResult {
  if (typeof raw !== "string") {
    return { ok: false, message: "Enter your email address." };
  }

  // Strip whitespace including the non-breaking space that pasting from a
  // document or a mail client tends to bring along.
  const value = raw.replace(/[\s ]+/g, "").trim();

  if (value.length === 0) {
    return { ok: false, message: "Enter your email address." };
  }
  if (value.length > MAX_EMAIL_LENGTH) {
    return { ok: false, message: "That address is too long to be real." };
  }
  // Header injection has no route into a JSON API body, but an address
  // containing a newline is malformed regardless, so refuse it early.
  if (/[\r\n\0]/.test(value)) {
    return { ok: false, message: "That address doesn’t look right." };
  }

  const at = value.lastIndexOf("@");
  if (at < 1 || value.slice(0, at).length > MAX_LOCAL_LENGTH) {
    return { ok: false, message: "That address doesn’t look right. Check it and try again." };
  }
  if (!EMAIL_RE.test(value)) {
    return { ok: false, message: "That address doesn’t look right. Check it and try again." };
  }

  // Normalise the domain only. Local parts are case-sensitive per spec, and
  // lowercasing them silently breaks the minority of servers that honour that.
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();
  return { ok: true, email: `${local}@${domain}` };
}

/** Escapes text for interpolation into the HTML email body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
