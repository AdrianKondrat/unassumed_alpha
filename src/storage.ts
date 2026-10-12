/**
 * Supabase persistence for waitlist signups (table `public.beta_signups`, see
 * supabase/beta_signups.sql).
 *
 * The row is written *before* Resend is called, so an email outage costs a
 * notification (recoverable: `notified_at IS NULL`), never the signup itself.
 *
 * Talks to PostgREST with the service-role key, which stays server-side as a
 * Worker secret. Every function degrades rather than throws.
 */
import type { Env } from "./env";

export type StoreResult =
  | { status: "created"; id: string }
  | { status: "duplicate" }
  | { status: "unavailable" };

export interface SignupRecord {
  email: string;
  source: string;
  country: string;
  userAgent: string;
  receivedAt: string;
}

type SupabaseEnv = Pick<Env, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">;

function endpoint(env: SupabaseEnv, query = ""): string {
  return `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/beta_signups${query}`;
}

function headers(env: SupabaseEnv, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/**
 * Inserts a signup, or reports that the address is already on the list.
 * `ignore-duplicates` against the unique index on `email_normalised` makes the
 * check atomic: a duplicate returns an empty array.
 */
export async function storeSignup(env: SupabaseEnv, record: SignupRecord): Promise<StoreResult> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("supabase_not_configured");
    return { status: "unavailable" };
  }

  try {
    const response = await fetch(endpoint(env, "?on_conflict=email_normalised"), {
      method: "POST",
      headers: headers(env, { Prefer: "resolution=ignore-duplicates,return=representation" }),
      body: JSON.stringify({
        email: record.email,
        email_normalised: record.email.toLowerCase(),
        source: record.source,
        country: record.country,
        user_agent: record.userAgent,
        created_at: record.receivedAt,
      }),
    });

    if (!response.ok) {
      console.error("supabase_store_failed", {
        status: response.status,
        body: (await response.text()).slice(0, 300),
        email: record.email,
      });
      return { status: "unavailable" };
    }

    const rows = (await response.json()) as Array<{ id: string }>;
    return rows.length > 0 ? { status: "created", id: rows[0]!.id } : { status: "duplicate" };
  } catch (cause) {
    console.error("supabase_store_failed", {
      error: cause instanceof Error ? cause.message : String(cause),
      email: record.email,
    });
    return { status: "unavailable" };
  }
}

/** Stamps a row once its email has gone out. Best effort by design. */
export async function markSent(
  env: SupabaseEnv,
  id: string,
  column: "notified_at" | "confirmed_at",
): Promise<void> {
  try {
    const response = await fetch(endpoint(env, `?id=eq.${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: headers(env),
      body: JSON.stringify({ [column]: new Date().toISOString() }),
    });
    if (!response.ok) console.error("supabase_mark_failed", { column, id, status: response.status });
  } catch (cause) {
    console.error("supabase_mark_failed", { column, id, error: String(cause) });
  }
}
