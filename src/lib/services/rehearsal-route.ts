// Shared plumbing for the three JSON rehearsal routes (turns, retry, end): authenticate, build both clients,
// parse a JSON body, answer in the one response shape. Server-only (imports the service-role client).
import type { APIContext } from "astro";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabase-admin";
import { isJsonContentType, statusForCode, toPublicTurn } from "./rehearsal-http";
import type { TurnResult } from "./rehearsal-service";

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export interface RouteContext {
  founderId: string;
  sessionId: string;
  supabase: SupabaseClient;
  admin: SupabaseClient;
}

/** Resolves the caller, the session id and both clients, or the response to send instead. */
export function prepare(context: APIContext): RouteContext | Response {
  const { user } = context.locals;
  if (!user) return json(401, { error: "unauthenticated", message: "Please sign in again." });

  const sessionId = z.uuid().safeParse(context.params.id);
  if (!sessionId.success) return json(404, { error: "not_found", message: "We couldn't find that session." });

  const supabase = createClient(context.request.headers, context.cookies);
  const admin = createServiceClient();
  if (!supabase || !admin) {
    return json(500, { error: "server_error", message: "Something went wrong on our side. Try again." });
  }
  return { founderId: user.id, sessionId: sessionId.data, supabase, admin };
}

/** The parsed JSON body, or a 415/400 response. */
export async function readJsonBody(
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

/** Maps a send/retry outcome to a response. Bodies carry turns (seq, question, reply) and codes, nothing else. */
export function turnResponse(result: TurnResult): Response {
  if (result.ok) return json(200, { turn: toPublicTurn(result.turn), ended: result.ended });
  return json(statusForCode(result.code), {
    error: result.code,
    message: result.message,
    ...(result.turn ? { turn: toPublicTurn(result.turn) } : {}),
  });
}
