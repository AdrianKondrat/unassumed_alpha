import type { APIRoute } from "astro";
import { isJsonContentType } from "@/lib/services/rehearsal-http";
import { json, prepare, turnResponse } from "@/lib/services/rehearsal-route";
import { retryReply } from "@/lib/services/rehearsal-service";

export const prerender = false;

// Re-requests the reply to the latest unanswered question. Never adds a turn.
export const POST: APIRoute = async (context) => {
  const ready = prepare(context);
  if (ready instanceof Response) return ready;
  if (!isJsonContentType(context.request.headers.get("Content-Type"))) {
    return json(415, { error: "unsupported_media_type", message: "Send JSON." });
  }
  return turnResponse(await retryReply(ready));
};
