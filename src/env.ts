/**
 * Bindings and configuration available to the Worker.
 *
 * Everything optional here is optional on purpose: the Worker must keep working
 * on a fresh account where the rate-limiting binding has not been provisioned
 * and Turnstile has not been set up yet.
 */

/** Shape of the Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Static assets in `public/`. Used to serve our own 404 page. */
  ASSETS: Fetcher;

  /** Secret. `wrangler secret put RESEND_API_KEY`. */
  RESEND_API_KEY: string;

  /** Secret, optional. Set only when a Turnstile widget is on the form. */
  TURNSTILE_SECRET_KEY?: string;

  /** Optional. Absent on accounts where the binding has not been created. */
  WAITLIST_LIMITER?: RateLimiter;

  SITE_ORIGIN: string;
  BRAND_NAME: string;
  NOTIFY_TO: string;
  FROM_ADDRESS: string;
  /** "true" to also send the signer-up a confirmation. */
  SEND_CONFIRMATION: string;
}
