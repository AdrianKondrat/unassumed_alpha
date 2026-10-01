// Orchestrates one canvas draft: take the in-flight lease, call the model, validate, insert, release.
// Pure logic (prompt, schema, parser) is in ./canvas-draft.ts. Founder content is never logged here.
import type { SupabaseClient } from "@supabase/supabase-js";
import { complete } from "@/lib/ai";
import { AI_DAILY_LIMIT_COPY } from "@/lib/ai-request";
import type { AIErrorKind } from "@/lib/ai-request";
import { buildDraftMessages, parseDraft } from "./canvas-draft";

export type DraftErrorCode =
  "already_drafted" | "in_progress" | "not_found" | "ai_failed" | "invalid_output" | "daily_limit";

export type DraftResult = { ok: true } | { ok: false; code: DraftErrorCode; message: string };

const AI_FAILURE_COPY: Record<AIErrorKind, string> = {
  timeout: "The AI took too long to answer. Try again in a moment.",
  rate_limited: "The AI service is busy right now. Try again in a minute.",
  daily_limit: AI_DAILY_LIMIT_COPY,
  provider_error: "We couldn't reach the AI service. Try again in a moment.",
  invalid_response: "The AI service sent back something unreadable. Try again.",
};

async function releaseLease(supabase: SupabaseClient, projectId: string): Promise<void> {
  const { error } = await supabase.from("projects").update({ draft_started_at: null }).eq("id", projectId);
  if (error) {
    // The 60 s staleness window recovers a lease we failed to release.
    // eslint-disable-next-line no-console
    console.error("releaseLease failed", error.code);
  }
}

export async function draftCanvas(params: {
  supabase: SupabaseClient;
  founderId: string;
  projectId: string;
}): Promise<DraftResult> {
  const { supabase, founderId, projectId } = params;

  // 1. Load the project (RLS-scoped, so a missing row means it is not this founder's), then take the lease
  //    with one atomic database call. `false` means another request holds a fresh lease.
  const { data: project, error: loadError } = await supabase
    .from("projects")
    .select("id, brief")
    .eq("id", projectId)
    .maybeSingle<{ id: string; brief: string }>();
  if (loadError) {
    // eslint-disable-next-line no-console
    console.error("draft project load failed", loadError.code);
    return { ok: false, code: "ai_failed", message: "Something went wrong on our side. Try again." };
  }
  if (!project) return { ok: false, code: "not_found", message: "We couldn't find that project." };

  const lease = await supabase
    .rpc("claim_draft_lease", { project: projectId })
    .overrideTypes<boolean, { merge: false }>();
  const { data: leased, error: leaseError } = lease;
  if (leaseError) {
    // eslint-disable-next-line no-console
    console.error("draft lease failed", leaseError.code);
    return { ok: false, code: "ai_failed", message: "Something went wrong on our side. Try again." };
  }
  if (leased !== true) {
    return { ok: false, code: "in_progress", message: "A draft is already being written. Give it a few seconds." };
  }

  // 2. Checked after the lease so a draft that finished a moment ago is never overwritten or paid for twice.
  const { count, error: countError } = await supabase
    .from("canvas_claims")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  if (countError) {
    await releaseLease(supabase, projectId);
    // eslint-disable-next-line no-console
    console.error("draft claim count failed", countError.code);
    return { ok: false, code: "ai_failed", message: "Something went wrong on our side. Try again." };
  }
  if (count) {
    await releaseLease(supabase, projectId);
    return { ok: false, code: "already_drafted", message: "This project already has a canvas." };
  }

  // 3. Ask the model, then validate. Any failure releases the lease so Retry works immediately.
  const ai = await complete({
    taskKind: "draft",
    messages: buildDraftMessages(project.brief),
    supabase,
    founderId,
    jsonMode: true,
  });
  if (!ai.ok) {
    await releaseLease(supabase, projectId);
    // eslint-disable-next-line no-console
    console.error("canvas draft AI call failed", ai.error.kind);
    return {
      ok: false,
      code: ai.error.kind === "daily_limit" ? "daily_limit" : "ai_failed",
      message: AI_FAILURE_COPY[ai.error.kind],
    };
  }

  const parsed = parseDraft(ai.text);
  if (!parsed.ok) {
    await releaseLease(supabase, projectId);
    // `reason` names a block or schema path only, never model or founder text.
    // eslint-disable-next-line no-console
    console.error("canvas draft rejected:", parsed.reason);
    return {
      ok: false,
      code: "invalid_output",
      message: "The draft didn't come back in a usable shape. Try again.",
    };
  }

  // 4. One insert = all claims or none. A unique violation means a parallel draft won the race.
  const { error: insertError } = await supabase.from("canvas_claims").insert(
    parsed.claims.map((claim) => ({
      project_id: projectId,
      block: claim.block,
      position: claim.position,
      text: claim.text,
      origin: "ai_draft" as const,
    })),
  );
  await releaseLease(supabase, projectId);
  if (insertError) {
    if (insertError.code === "23505") {
      return { ok: false, code: "already_drafted", message: "This project already has a canvas." };
    }
    // eslint-disable-next-line no-console
    console.error("canvas claims insert failed", insertError.code);
    return { ok: false, code: "ai_failed", message: "We couldn't save the draft. Try again." };
  }

  return { ok: true };
}
