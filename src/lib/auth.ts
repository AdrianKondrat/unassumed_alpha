// Auth helpers shared by the auth routes and pages. Pure (no `astro:*`, no `@/`) so scripts/test-auth.mjs
// can import it with `node --experimental-strip-types`.
import { z } from "zod";

/** Keep in sync with `minimum_password_length` in supabase/config.toml. */
export const MIN_PASSWORD_LENGTH = 8;

export const emailSchema = z
  .string("Enter your email address")
  .trim()
  .toLowerCase()
  .max(254, "Enter a valid email address")
  .pipe(z.email("Enter a valid email address"));

export const newPasswordSchema = z
  .string("Enter a password")
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(72, "Password must be at most 72 characters");

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string("Enter your password").min(1, "Enter your password").max(72),
});

export const signUpSchema = z
  .object({
    email: emailSchema,
    password: newPasswordSchema,
    confirmPassword: z.string().optional(),
  })
  .refine((v) => v.confirmPassword === undefined || v.confirmPassword === v.password, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const emailOnlySchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({
    password: newPasswordSchema,
    confirmPassword: z.string().optional(),
  })
  .refine((v) => v.confirmPassword === undefined || v.confirmPassword === v.password, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/** First human-readable problem from a zod error. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the form and try again";
}

/** Turn FormData (or any iterable of entries) into a plain object of string values. */
export function formToObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

interface AuthErrorLike {
  code?: string | undefined;
  message?: string;
}

/**
 * Founder-friendly copy for Supabase auth errors. Never forwards the raw provider message, which can be
 * technical or reveal whether an account exists.
 */
export function authErrorMessage(error: AuthErrorLike | null | undefined): string {
  switch (error?.code) {
    case "invalid_credentials":
      return "Incorrect email or password.";
    case "email_not_confirmed":
      return "Verify your email before signing in. We can send the link again.";
    case "otp_expired":
    case "flow_state_expired":
    case "flow_state_not_found":
    case "bad_code_verifier":
    case "validation_failed":
      return "That link has expired or was already used. Request a new one.";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
    case "over_sms_send_rate_limit":
      return "Too many attempts. Wait a minute and try again.";
    case "weak_password":
      return `That password is too weak. Use at least ${MIN_PASSWORD_LENGTH} characters and avoid common passwords.`;
    case "same_password":
      return "Choose a password you are not already using.";
    case "session_not_found":
    case "session_expired":
    case "refresh_token_not_found":
      return "Your session has expired. Sign in again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/**
 * Only same-origin absolute paths are allowed as post-auth redirect targets (open-redirect guard).
 * Rejects absolute URLs, protocol-relative `//host`, backslash tricks and control characters.
 */
export function safeNext(value: string | null | undefined, fallback = "/dashboard"): string {
  if (!value) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  return value;
}

export function errorRedirect(path: string, message: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`;
}
