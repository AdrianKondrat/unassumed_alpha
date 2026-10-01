import type { APIRoute } from "astro";
import { createClaimSchema } from "@/lib/services/canvas-edit";
import { createClaim } from "@/lib/services/claims";
import { claimResponse, invalid, prepareClaims, readClaimBody } from "@/lib/services/claims-route";

export const prerender = false;

// Adds a founder-authored claim to a block of the founder's own project (next free position, per-block cap).
export const POST: APIRoute = async (context) => {
  const ready = prepareClaims(context);
  if (ready instanceof Response) return ready;
  const body = await readClaimBody(context.request);
  if (!body.ok) return body.response;
  const input = createClaimSchema.safeParse(body.body);
  if (!input.success) return invalid(input.error.issues[0]?.message ?? "That claim isn't valid");

  return claimResponse(await createClaim({ supabase: ready.supabase, ...input.data }), 201);
};
