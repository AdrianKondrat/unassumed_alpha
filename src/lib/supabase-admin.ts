// SERVER-ONLY. A service-role Supabase client: it bypasses RLS, so it must never be imported by an Astro
// page's props, a React island, or any module a client bundle can reach. Today its one job is the hidden
// rehearsal persona: reading the scenario and writing sessions/turns through the service-only DB functions.
//
// Callers must prove ownership with the founder's own RLS-scoped client (src/lib/supabase.ts) BEFORE using
// this client for anything keyed by an id the request supplied.
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "astro:env/server";

/** Returns a service-role client with no session persistence, or `null` when the secret is not configured. */
export function createServiceClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
