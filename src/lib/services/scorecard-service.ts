// Scores an ended rehearsal session: claim the lease, load the founder's questions, run the deadline-bound
// attempt loop (./scorecard-run.ts), store the result. Pure logic is in ./scorecard.ts and ./scorecard-run.ts.
//
// Two clients, as in the rehearsal service: the founder's RLS client proves ownership, reads the turns and is the
// one passed to `complete()` (usage is attributed to the founder); the service client only calls the two
// service-only functions. Nothing here logs questions, replies or model text: only codes and parser reasons.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { complete } from "@/lib/ai";
import { runScoring } from "./scorecard-run";
import type { ScoreErrorKind } from "./scorecard-run";
import { SCORE_FAILURE_COPY } from "./scorecard";
import type { ParsedScore, ScoreTurn } from "./scorecard";
import { getSession } from "./rehearsals";

const ClaimSchema = z.enum(["not_found", "not_ended", "ready", "insufficient", "in_progress", "claimed"]);
const StoreSchema = z.object({ ok: z.boolean(), code: z.string().optional() });

export type ScoreStatus = "ready" | "insufficient" | "failed" | "in_progress";

export type ScoreResult =
  | { ok: true; status: ScoreStatus; message?: string }
  | { ok: false; code: "not_found" | "not_ended" | "server_error"; message: string };

const SERVER_ERROR: ScoreResult = {
  ok: false,
  code: "server_error",
  message: "Something went wrong on our side. Try again.",
};

interface StoreArgs {
  status: "ready" | "failed" | "insufficient";
  summary?: string;
  model?: string;
  errorKind?: ScoreErrorKind | "server_error";
  score?: ParsedScore;
}

/** Finishes a claimed attempt. Returns false when the store itself failed (the lease then expires in 60 s). */
async function store(admin: SupabaseClient, sessionId: string, args: StoreArgs): Promise<boolean> {
  const result = await admin.rpc("store_scorecard", {
    p_session: sessionId,
    p_status: args.status,
    p_summary: args.summary ?? null,
    p_model: args.model ?? null,
    p_error_kind: args.errorKind ?? null,
    // Positions and prose only: the database copies every quote from the stored turn.
    p_flags: (args.score?.flags ?? []).map((f) => ({ seq: f.seq, label: f.label, explanation: f.explanation })),
    p_rewrites: (args.score?.rewrites ?? []).map((r) => ({ seq: r.seq, suggestion: r.suggestion })),
  });
  const parsed = StoreSchema.safeParse(result.data);
  if (result.error || !parsed.success || !parsed.data.ok) {
    // eslint-disable-next-line no-console
    console.error("store_scorecard failed", result.error?.code ?? parsed.data?.code ?? "unexpected result");
    return false;
  }
  return true;
}

/**
 * Scores the session if it has not been scored. Idempotent and race-safe: finished scorecards are returned as
 * they are, a fresh lease held elsewhere reports `in_progress`, and a failed earlier attempt is retried.
 */
export async function scoreSession(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  founderId: string;
  sessionId: string;
}): Promise<ScoreResult> {
  const { supabase, admin, founderId, sessionId } = params;

  // Ownership first: a session the founder cannot see is simply not found.
  const session = await getSession(supabase, sessionId);
  if (!session) return { ok: false, code: "not_found", message: "We couldn't find that session." };
  if (session.status !== "ended") {
    return { ok: false, code: "not_ended", message: "End the session before it can be scored." };
  }

  const claimCall = await admin.rpc("claim_scorecard", { p_session: sessionId });
  const claim = ClaimSchema.safeParse(claimCall.data);
  if (claimCall.error || !claim.success) {
    // eslint-disable-next-line no-console
    console.error("claim_scorecard failed", claimCall.error?.code ?? "unexpected result");
    return SERVER_ERROR;
  }
  switch (claim.data) {
    case "not_found":
      return { ok: false, code: "not_found", message: "We couldn't find that session." };
    case "not_ended":
      return { ok: false, code: "not_ended", message: "End the session before it can be scored." };
    case "ready":
    case "insufficient":
    case "in_progress":
      return { ok: true, status: claim.data };
    case "claimed":
      break;
  }

  // From here this request holds the lease, so every path must store a result to release it.
  try {
    const turnsResult = await supabase
      .from("rehearsal_turns")
      .select("seq, question, reply")
      .eq("session_id", sessionId)
      .order("seq", { ascending: true })
      .overrideTypes<ScoreTurn[], { merge: false }>();
    if (turnsResult.error) throw new Error(`turns read failed: ${turnsResult.error.code}`);
    const turns = turnsResult.data;

    if (turns.length === 0) {
      // Nothing to assess: say so, and spend no AI call.
      const saved = await store(admin, sessionId, { status: "insufficient" });
      return saved ? { ok: true, status: "insufficient" } : SERVER_ERROR;
    }

    const outcome = await runScoring({
      turns,
      now: () => Date.now(),
      ask: async (messages, timeoutMs) => {
        const ai = await complete({
          taskKind: "score",
          messages,
          supabase,
          founderId,
          jsonMode: true,
          timeoutMs,
          retry: false,
        });
        if (!ai.ok) {
          // eslint-disable-next-line no-console
          console.error("scorecard AI call failed", ai.error.kind);
          return { ok: false as const, kind: ai.error.kind };
        }
        return { ok: true as const, text: ai.text, model: ai.model };
      },
    });

    if (outcome.ok) {
      const saved = await store(admin, sessionId, {
        status: "ready",
        summary: outcome.score.summary,
        model: outcome.model,
        score: outcome.score,
      });
      return saved ? { ok: true, status: "ready" } : SERVER_ERROR;
    }

    // `reasons` name paths and positions only, never model or founder text.
    // eslint-disable-next-line no-console
    console.error("scorecard attempt failed:", outcome.errorKind, outcome.reasons.join("; "));
    const saved = await store(admin, sessionId, { status: "failed", errorKind: outcome.errorKind });
    return saved ? { ok: true, status: "failed", message: SCORE_FAILURE_COPY[outcome.errorKind] } : SERVER_ERROR;
  } catch (error) {
    // Unexpected: release the lease so the founder can retry straight away instead of waiting 60 s.
    // eslint-disable-next-line no-console
    console.error("scoreSession failed", error instanceof Error ? error.message.slice(0, 80) : "unknown");
    await store(admin, sessionId, { status: "failed", errorKind: "server_error" });
    return { ok: true, status: "failed", message: SCORE_FAILURE_COPY.server_error };
  }
}
