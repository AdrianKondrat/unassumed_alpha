import type { APIRoute } from "astro";
import { isJsonContentType, statusForCode } from "@/lib/services/rehearsal-http";
import { json, prepare } from "@/lib/services/rehearsal-route";
import { endSession } from "@/lib/services/rehearsal-service";

export const prerender = false;

// Ends the founder's session early. Idempotent.
export const POST: APIRoute = async (context) => {
  const ready = prepare(context);
  if (ready instanceof Response) return ready;
  if (!isJsonContentType(context.request.headers.get("Content-Type"))) {
    return json(415, { error: "unsupported_media_type", message: "Send JSON." });
  }

  const result = await endSession({ supabase: ready.supabase, admin: ready.admin, sessionId: ready.sessionId });
  if (!result.ok) return json(statusForCode(result.code), { error: result.code, message: result.message });
  return json(200, { ended: true });
};
