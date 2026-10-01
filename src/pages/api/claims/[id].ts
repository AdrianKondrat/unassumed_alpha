import type { APIRoute } from "astro";
import { z } from "zod";
import { deleteClaimSchema, updateClaimSchema } from "@/lib/services/canvas-edit";
import { deleteClaim, updateClaim } from "@/lib/services/claims";
import { claimResponse, invalid, json, prepareClaims, readClaimBody } from "@/lib/services/claims-route";

export const prerender = false;

const NOT_FOUND = { error: "not_found", message: "We couldn't find that claim. It may have been deleted." };

// Saves new text for a claim at the revision the editor loaded. 409 with the saved claim when someone saved first.
export const PATCH: APIRoute = async (context) => {
  const ready = prepareClaims(context);
  if (ready instanceof Response) return ready;
  const id = z.uuid().safeParse(context.params.id);
  if (!id.success) return json(404, NOT_FOUND);
  const body = await readClaimBody(context.request);
  if (!body.ok) return body.response;
  const input = updateClaimSchema.safeParse(body.body);
  if (!input.success) return invalid(input.error.issues[0]?.message ?? "That edit isn't valid");

  return claimResponse(await updateClaim({ supabase: ready.supabase, id: id.data, ...input.data }));
};

// Deletes a claim at the revision the editor loaded. Already gone is success; a newer revision is a 409.
export const DELETE: APIRoute = async (context) => {
  const ready = prepareClaims(context);
  if (ready instanceof Response) return ready;
  const id = z.uuid().safeParse(context.params.id);
  if (!id.success) return json(404, NOT_FOUND);
  const body = await readClaimBody(context.request);
  if (!body.ok) return body.response;
  const input = deleteClaimSchema.safeParse(body.body);
  if (!input.success) return invalid(input.error.issues[0]?.message ?? "That delete isn't valid");

  const result = await deleteClaim({ supabase: ready.supabase, id: id.data, ...input.data });
  return result.ok ? json(200, { deleted: true }) : claimResponse(result);
};
