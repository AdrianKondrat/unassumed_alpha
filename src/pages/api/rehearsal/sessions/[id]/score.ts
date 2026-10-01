import type { APIRoute } from "astro";
import { isJsonContentType, statusForCode } from "@/lib/services/rehearsal-http";
import { json, prepare } from "@/lib/services/rehearsal-route";
import { scoreSession } from "@/lib/services/scorecard-service";

export const prerender = false;

// Scores an ended session (idempotent). The scorecard page calls it on arrival and for Retry. Finished
// scorecards come straight back, a fresh lease elsewhere answers `in_progress`, and a failed scoring is a normal
// 200 with status `failed` (a saved state the founder can retry), not an HTTP error. Bodies carry only a status
// and a message; the scorecard itself is rendered from RLS-scoped reads.
export const POST: APIRoute = async (context) => {
  const ready = prepare(context);
  if (ready instanceof Response) return ready;
  if (!isJsonContentType(context.request.headers.get("Content-Type"))) {
    return json(415, { error: "unsupported_media_type", message: "Send JSON." });
  }

  const result = await scoreSession(ready);
  if (!result.ok) return json(statusForCode(result.code), { error: result.code, message: result.message });
  return json(200, { status: result.status, ...(result.message ? { message: result.message } : {}) });
};
