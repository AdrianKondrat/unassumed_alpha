// Orchestrates one suggestion batch: guards (no spend if there is nothing to do), lease, model call, parse,
// atomic insert, release. Pure logic is in ./assumption-suggest.ts. Founder content is never logged here.
import type { SupabaseClient } from "@supabase/supabase-js";
import { complete } from "@/lib/ai";
import { AI_DAILY_LIMIT_COPY } from "@/lib/ai-request";
import type { AIErrorKind } from "@/lib/ai-request";
import { MAX_REJECTED_IN_PROMPT, buildSuggestMessages, parseSuggestions } from "./assumption-suggest";
import type { PromptClaim } from "./assumption-suggest";

export type SuggestErrorCode =
  "no_claims" | "pending_batch" | "in_progress" | "not_found" | "ai_failed" | "invalid_output" | "daily_limit";

export type SuggestResult = { ok: true } | { ok: false; code: SuggestErrorCode; message: string };

const AI_FAILURE_COPY: Record<AIErrorKind, string> = {
  timeout: "The AI took too long to answer. Try again in a moment.",
  rate_limited: "The AI service is busy right now. Try again in a minute.",
  daily_limit: AI_DAILY_LIMIT_COPY,
  provider_error: "We couldn't reach the AI service. Try again in a moment.",
  invalid_response: "The AI service sent back something unreadable. Try again.",
};

const SERVER_ERROR: SuggestResult = {
  ok: false,
  code: "ai_failed",
  message: "Something went wrong on our side. Try again.",
};

async function releaseLease(supabase: SupabaseClient, projectId: string): Promise<void> {
  const { error } = await supabase.from("projects").update({ suggest_started_at: null }).eq("id", projectId);
  if (error) {
    // The 60 s staleness window recovers a lease we failed to release.
    // eslint-disable-next-line no-console
    console.error("suggest releaseLease failed", error.code);
  }
}

async function countPending(supabase: SupabaseClient, projectId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from("assumptions")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("status", "suggested");
  if (error) {
    // eslint-disable-next-line no-console
    console.error("suggest pending count failed", error.code);
    return null;
  }
  return count ?? 0;
}

export async function suggestAssumptions(params: {
  supabase: SupabaseClient;
  founderId: string;
  projectId: string;
}): Promise<SuggestResult> {
  const { supabase, founderId, projectId } = params;

  // 1. Guards that must not cost an AI call. RLS scopes every read to the caller's own project.
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle<{ id: string }>();
  if (projectError) return SERVER_ERROR;
  if (!project) return { ok: false, code: "not_found", message: "We couldn't find that project." };

  const claimsResult = await supabase
    .from("canvas_claims")
    .select("id, block, text")
    .eq("project_id", projectId)
    .order("position", { ascending: true })
    .overrideTypes<PromptClaim[], { merge: false }>();
  if (claimsResult.error) return SERVER_ERROR;
  const claims = claimsResult.data;
  if (claims.length === 0) {
    return { ok: false, code: "no_claims", message: "Draft your canvas first so there is something to work from." };
  }

  const pendingBefore = await countPending(supabase, projectId);
  if (pendingBefore === null) return SERVER_ERROR;
  if (pendingBefore > 0) {
    return { ok: false, code: "pending_batch", message: "Review your current suggestions first." };
  }

  // 2. Take the lease (one atomic database call). Re-check pending after, so a batch that landed a moment
  //    ago is never paid for or duplicated.
  const lease = await supabase
    .rpc("claim_suggest_lease", { project: projectId })
    .overrideTypes<boolean, { merge: false }>();
  if (lease.error) {
    // eslint-disable-next-line no-console
    console.error("suggest lease failed", lease.error.code);
    return SERVER_ERROR;
  }
  if (lease.data !== true) {
    return { ok: false, code: "in_progress", message: "Suggestions are already being written. Give it a few seconds." };
  }

  const pendingAfter = await countPending(supabase, projectId);
  if (pendingAfter === null) {
    await releaseLease(supabase, projectId);
    return SERVER_ERROR;
  }
  if (pendingAfter > 0) {
    await releaseLease(supabase, projectId);
    return { ok: false, code: "pending_batch", message: "Review your current suggestions first." };
  }

  // 3. Prompt inputs: the latest rejected statements steer the model away from repeats.
  const rejected = await supabase
    .from("assumptions")
    .select("statement")
    .eq("project_id", projectId)
    .eq("status", "rejected")
    .order("updated_at", { ascending: false })
    .limit(MAX_REJECTED_IN_PROMPT)
    .overrideTypes<{ statement: string }[], { merge: false }>();
  // Losing the repeat-avoidance list is not worth failing the request over.
  const rejectedStatements = rejected.error ? [] : rejected.data.map((row) => row.statement);

  const ai = await complete({
    taskKind: "suggest",
    messages: buildSuggestMessages({ claims, rejectedStatements }),
    supabase,
    founderId,
    jsonMode: true,
  });
  if (!ai.ok) {
    await releaseLease(supabase, projectId);
    // eslint-disable-next-line no-console
    console.error("assumption suggest AI call failed", ai.error.kind);
    return {
      ok: false,
      code: ai.error.kind === "daily_limit" ? "daily_limit" : "ai_failed",
      message: AI_FAILURE_COPY[ai.error.kind],
    };
  }

  const parsed = parseSuggestions(ai.text, new Set(claims.map((claim) => claim.id)));
  if (!parsed.ok) {
    await releaseLease(supabase, projectId);
    // `reason` names a path or index only, never model or founder text.
    // eslint-disable-next-line no-console
    console.error("assumption suggestions rejected:", parsed.reason);
    return {
      ok: false,
      code: "invalid_output",
      message: "The suggestions didn't come back in a usable shape. Try again.",
    };
  }

  // 4. One database call inserts every candidate and its links, or nothing.
  const insert = await supabase.rpc("create_suggested_assumptions", {
    project: projectId,
    items: parsed.suggestions.map((s) => ({ statement: s.statement, risk_note: s.riskNote, claim_ids: s.claimIds })),
  });
  await releaseLease(supabase, projectId);
  if (insert.error) {
    // eslint-disable-next-line no-console
    console.error("create_suggested_assumptions failed", insert.error.code);
    return { ok: false, code: "ai_failed", message: "We couldn't save the suggestions. Try again." };
  }
  return { ok: true };
}
