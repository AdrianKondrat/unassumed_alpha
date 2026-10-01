// Shared plumbing for the canvas claim JSON routes: authenticate, build the founder's RLS client, read a JSON
// body, answer in one response shape. Bodies carry claims (allow-listed fields) and codes, nothing else.
import type { APIContext } from "astro";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase";
import { statusForClaimCode } from "./canvas-edit";
import { isJsonContentType } from "./rehearsal-http";
import type { ClaimResult } from "./claims";

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The founder's client, or the response to send instead (401 when signed out). */
export function prepareClaims(context: APIContext): { supabase: SupabaseClient } | Response {
  if (!context.locals.user) return json(401, { error: "unauthenticated", message: "Please sign in again." });
  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) return json(500, { error: "server_error", message: "Something went wrong on our side. Try again." });
  return { supabase };
}

/** The parsed JSON body, or a 415/400 response. JSON only: a cross-site form cannot send this content type. */
export async function readClaimBody(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return { ok: false, response: json(415, { error: "unsupported_media_type", message: "Send JSON." }) };
  }
  try {
    return { ok: true, body: (await request.json()) as unknown };
  } catch {
    return { ok: false, response: json(400, { error: "invalid", message: "That request was not valid JSON." }) };
  }
}

export function invalid(message: string): Response {
  return json(statusForClaimCode("invalid"), { error: "invalid", message });
}

/** A claim result as a response: the claim on success, a code (and the saved claim for a conflict) otherwise. */
export function claimResponse(result: ClaimResult, okStatus = 200): Response {
  if (result.ok) return json(okStatus, { claim: result.claim });
  return json(statusForClaimCode(result.code), {
    error: result.code,
    message: result.message,
    ...(result.current ? { current: result.current } : {}),
  });
}
