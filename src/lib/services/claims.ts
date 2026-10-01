// Manual canvas edits (S-03): create, update and delete a claim. Everything runs under the founder's own RLS
// client; the revision and origin rules are the database's (canvas_claims_guard trigger, add_canvas_claim function),
// this layer only translates "zero rows" into a conflict that carries the saved version. Founder text is never logged.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { CanvasBlockKey, PublicClaim } from "@/types";
import { toPublicClaim } from "./canvas-edit";
import type { ClaimErrorCode } from "./canvas-edit";
import { getCurrentProject } from "./project";

const CLAIM_COLUMNS = "id, block, position, text, origin, revision";

type ClaimRow = Parameters<typeof toPublicClaim>[0];

export interface ClaimFailure {
  ok: false;
  code: ClaimErrorCode;
  message: string;
  current?: PublicClaim;
}
export type ClaimResult = { ok: true; claim: PublicClaim } | ClaimFailure;

const COPY: Record<ClaimErrorCode, string> = {
  not_found: "We couldn't find that claim. It may have been deleted.",
  conflict: "This claim changed since you opened it.",
  block_full: "That block is full. Delete or merge a claim before adding another.",
  server_error: "Something went wrong on our side. Try again.",
};

const fail = (code: ClaimErrorCode, current?: PublicClaim): ClaimFailure => ({
  ok: false,
  code,
  message: COPY[code],
  ...(current ? { current } : {}),
});

async function readClaim(supabase: SupabaseClient, id: string): Promise<{ row: ClaimRow | null; failed: boolean }> {
  const { data, error } = await supabase
    .from("canvas_claims")
    .select(CLAIM_COLUMNS)
    .eq("id", id)
    .maybeSingle<ClaimRow>();
  if (error) {
    // eslint-disable-next-line no-console
    console.error("claim read failed", error.code);
    return { row: null, failed: true };
  }
  return { row: data, failed: false };
}

/**
 * Saves new text for a claim, but only if it is still at `expectedRevision` (one conditional UPDATE, so of two
 * saves racing from the same revision exactly one wins). A loser gets `conflict` with the saved claim. A save
 * whose text already matches the saved text is a success: there is nothing to lose.
 */
export async function updateClaim(params: {
  supabase: SupabaseClient;
  id: string;
  text: string;
  expectedRevision: number;
}): Promise<ClaimResult> {
  const { supabase, id, text, expectedRevision } = params;

  const updated = await supabase
    .from("canvas_claims")
    .update({ text })
    .eq("id", id)
    .eq("revision", expectedRevision)
    .select(CLAIM_COLUMNS)
    .overrideTypes<ClaimRow[], { merge: false }>();
  if (updated.error) {
    // eslint-disable-next-line no-console
    console.error("claim update failed", updated.error.code);
    return fail("server_error");
  }
  const saved = updated.data.at(0);
  if (saved) return { ok: true, claim: toPublicClaim(saved) };

  // Nothing matched: the claim is gone, or someone saved a newer revision.
  const { row, failed } = await readClaim(supabase, id);
  if (failed) return fail("server_error");
  if (!row) return fail("not_found");
  if (row.text === text) return { ok: true, claim: toPublicClaim(row) };
  return fail("conflict", toPublicClaim(row));
}

/** Deletes a claim at `expectedRevision`. Already gone counts as done; a newer revision is a conflict. */
export async function deleteClaim(params: {
  supabase: SupabaseClient;
  id: string;
  expectedRevision: number;
}): Promise<{ ok: true } | ClaimFailure> {
  const { supabase, id, expectedRevision } = params;

  const deleted = await supabase
    .from("canvas_claims")
    .delete()
    .eq("id", id)
    .eq("revision", expectedRevision)
    .select("id")
    .overrideTypes<{ id: string }[], { merge: false }>();
  if (deleted.error) {
    // eslint-disable-next-line no-console
    console.error("claim delete failed", deleted.error.code);
    return fail("server_error");
  }
  if (deleted.data.length > 0) return { ok: true };

  const { row, failed } = await readClaim(supabase, id);
  if (failed) return fail("server_error");
  if (!row) return { ok: true };
  return fail("conflict", toPublicClaim(row));
}

const AddSchema = z.object({
  ok: z.boolean(),
  code: z.string().optional(),
  claim: z
    .object({
      id: z.string(),
      block: z.string(),
      position: z.number().int(),
      text: z.string(),
      origin: z.enum(["ai_draft", "founder"]),
      revision: z.number().int(),
    })
    .optional(),
});

/** Adds a founder-authored claim to the founder's own project, at the block's next free position. */
export async function createClaim(params: {
  supabase: SupabaseClient;
  block: CanvasBlockKey;
  text: string;
}): Promise<ClaimResult> {
  const { supabase, block, text } = params;

  const project = await getCurrentProject(supabase);
  if (!project) return fail("not_found");

  const call = await supabase.rpc("add_canvas_claim", { p_project: project.id, p_block: block, p_text: text });
  if (call.error) {
    // eslint-disable-next-line no-console
    console.error("add_canvas_claim failed", call.error.code);
    return fail("server_error");
  }
  const parsed = AddSchema.safeParse(call.data);
  if (!parsed.success) return fail("server_error");
  if (!parsed.data.ok) return fail(parsed.data.code === "block_full" ? "block_full" : "server_error");
  if (!parsed.data.claim) return fail("server_error");
  return { ok: true, claim: toPublicClaim({ ...parsed.data.claim, block: parsed.data.claim.block as CanvasBlockKey }) };
}
