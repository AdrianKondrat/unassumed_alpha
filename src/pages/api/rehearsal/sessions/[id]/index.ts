import type { APIRoute } from "astro";
import { prepare, stateResponse } from "@/lib/services/rehearsal-route";
import { getSessionState } from "@/lib/services/rehearsal-service";

export const prerender = false;

// The resume state the chat island polls and refetches after a disruption: session status (with idle expiry
// applied), every saved turn once, and whether the latest unanswered turn is in flight elsewhere or needs a reply.
// Bodies carry seq, question, reply and the founder's own idempotency key per turn; never the scenario, a lease
// timestamp or anything else. Reading never counts as activity.
export const GET: APIRoute = async (context) => {
  const ready = prepare(context);
  if (ready instanceof Response) return ready;
  return stateResponse(await getSessionState(ready));
};
