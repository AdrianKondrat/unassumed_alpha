// Orchestrates a rehearsal: start (hidden scenario), send a question, retry a reply, end. Pure logic is in
// ./rehearsal-persona.ts; RLS-scoped reads are in ./rehearsals.ts.
//
// Two clients, two jobs. `supabase` is the founder's own RLS client: it proves ownership (a session or
// assumption it cannot see is "not found") and is the one passed to `complete()`, so usage rows are
// attributed to the founder. `admin` is the service-role client: it reads the hidden scenario and calls the
// service-only database functions, and only ever after an RLS read has proven the caller owns the row.
// Nothing here logs founder content, questions, replies or the scenario: only error codes and parser reasons
// that name a path.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { complete } from "@/lib/ai";
import type { AIErrorKind } from "@/lib/ai-request";
import type { RehearsalTurn } from "@/types";
import {
  ScenarioSchema,
  buildPersonaMessages,
  buildScenarioMessages,
  guardReply,
  parseScenario,
} from "./rehearsal-persona";
import type { PriorTurn } from "./rehearsal-persona";
import { getActiveSession, getSession } from "./rehearsals";

/** Scenario generation is a one-off, founder-initiated wait with a visible pending state; allow it longer than a reply. */
const SCENARIO_TIMEOUT_MS = 20_000;

const AI_FAILURE_COPY: Record<AIErrorKind, string> = {
  timeout: "The AI took too long to answer. Try again in a moment.",
  rate_limited: "The AI service is busy right now. Try again in a minute.",
  provider_error: "We couldn't reach the AI service. Try again in a moment.",
  invalid_response: "The AI service sent back something unreadable. Try again.",
};

const SERVER_ERROR_COPY = "Something went wrong on our side. Try again.";

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------
export type StartErrorCode =
  "assumption_not_found" | "assumption_inactive" | "ai_failed" | "invalid_output" | "server_error";

export type StartResult =
  { ok: true; sessionId: string; existing: boolean } | { ok: false; code: StartErrorCode; message: string };

const startFailure = (code: StartErrorCode, message: string): StartResult => ({ ok: false, code, message });

/**
 * Starts a session on one active assumption. If the project already has an active session, returns that one
 * instead (one active session per project). The scenario is generated first; the session and its scenario
 * are then created together by one database function, so a scenario-less session can never exist.
 */
export async function startSession(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  founderId: string;
  assumptionId: string;
}): Promise<StartResult> {
  const { supabase, admin, founderId, assumptionId } = params;

  const { data: assumption, error: assumptionError } = await supabase
    .from("assumptions")
    .select("id, project_id, statement, status")
    .eq("id", assumptionId)
    .maybeSingle<{ id: string; project_id: string; statement: string; status: string }>();
  if (assumptionError) return startFailure("server_error", SERVER_ERROR_COPY);
  if (!assumption) return startFailure("assumption_not_found", "We couldn't find that assumption.");
  if (assumption.status !== "active") {
    return startFailure("assumption_inactive", "Only an assumption you are keeping active can be rehearsed.");
  }

  const current = await getActiveSession(supabase, assumption.project_id);
  if (current) return { ok: true, sessionId: current.id, existing: true };

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("brief")
    .eq("id", assumption.project_id)
    .maybeSingle<{ brief: string }>();
  if (projectError || !project) return startFailure("server_error", SERVER_ERROR_COPY);

  const ai = await complete({
    taskKind: "converse",
    messages: buildScenarioMessages({ brief: project.brief, assumption: assumption.statement }),
    supabase,
    founderId,
    jsonMode: true,
    timeoutMs: SCENARIO_TIMEOUT_MS,
  });
  if (!ai.ok) {
    // eslint-disable-next-line no-console
    console.error("rehearsal scenario AI call failed", ai.error.kind);
    return startFailure("ai_failed", AI_FAILURE_COPY[ai.error.kind]);
  }

  const parsed = parseScenario(ai.text);
  if (!parsed.ok) {
    // `reason` names a path only, never model text.
    // eslint-disable-next-line no-console
    console.error("rehearsal scenario rejected:", parsed.reason);
    return startFailure("invalid_output", "We couldn't prepare your practice customer. Nothing was lost. Try again.");
  }

  const created = await admin.rpc("start_rehearsal_session", {
    p_assumption: assumption.id,
    p_scenario: parsed.scenario,
  });
  if (created.error) {
    if (created.error.code === "23505") {
      // A parallel start won the one-active-session race: join it rather than fail.
      const winner = await getActiveSession(supabase, assumption.project_id);
      if (winner) return { ok: true, sessionId: winner.id, existing: true };
    }
    // eslint-disable-next-line no-console
    console.error("start_rehearsal_session failed", created.error.code);
    return startFailure("server_error", SERVER_ERROR_COPY);
  }
  const sessionId = z.uuid().safeParse(created.data);
  if (!sessionId.success) return startFailure("server_error", SERVER_ERROR_COPY);
  return { ok: true, sessionId: sessionId.data, existing: false };
}

// ---------------------------------------------------------------------------------------------
// Replies (shared by send and retry)
// ---------------------------------------------------------------------------------------------
export type TurnErrorCode =
  | "not_found"
  | "not_active"
  | "reply_pending"
  | "cap_reached"
  | "nothing_to_retry"
  | "ai_failed"
  | "invalid_output"
  | "server_error";

export type TurnResult =
  | { ok: true; turn: RehearsalTurn; ended: boolean }
  /** `turn` is present when the question was saved but no reply could be produced (the UI shows Retry). */
  | { ok: false; code: TurnErrorCode; message: string; turn?: RehearsalTurn };

const TURN_COPY: Record<Exclude<TurnErrorCode, "ai_failed" | "invalid_output" | "server_error">, string> = {
  not_found: "We couldn't find that session.",
  not_active: "This session has ended.",
  reply_pending: "Wait for the reply to your last question first.",
  cap_reached: "You have used all your questions for this session.",
  nothing_to_retry: "There is no unanswered question to retry.",
};

const turnFailure = (code: TurnErrorCode, message: string, turn?: RehearsalTurn): TurnResult => ({
  ok: false,
  code,
  message,
  turn,
});

// What the service-only database functions return, validated rather than trusted.
const AddTurnSchema = z.object({ ok: z.boolean(), seq: z.number().int().optional(), code: z.string().optional() });
const StoreReplySchema = z.object({ ok: z.boolean(), stored: z.boolean().optional(), ended: z.boolean().optional() });

/** Produces and stores the persona's reply to one saved question. The question is never lost on failure. */
async function generateReply(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  founderId: string;
  sessionId: string;
  seq: number;
  question: string;
}): Promise<TurnResult> {
  const { supabase, admin, founderId, sessionId, seq, question } = params;
  const unanswered: RehearsalTurn = { seq, question, reply: null };

  const scenarioRow = await admin
    .from("rehearsal_scenarios")
    .select("scenario")
    .eq("session_id", sessionId)
    .maybeSingle<{ scenario: unknown }>();
  const scenario = ScenarioSchema.safeParse(scenarioRow.data?.scenario);
  if (scenarioRow.error || !scenario.success) {
    // eslint-disable-next-line no-console
    console.error("rehearsal scenario unreadable", scenarioRow.error?.code ?? "invalid shape");
    return turnFailure("server_error", SERVER_ERROR_COPY, unanswered);
  }

  // History is the replied turns before this one, read under the founder's RLS.
  const history = await supabase
    .from("rehearsal_turns")
    .select("question, reply")
    .eq("session_id", sessionId)
    .lt("seq", seq)
    .not("reply", "is", null)
    .order("seq", { ascending: true })
    .overrideTypes<PriorTurn[], { merge: false }>();
  if (history.error) return turnFailure("server_error", SERVER_ERROR_COPY, unanswered);

  const ai = await complete({
    taskKind: "converse",
    messages: buildPersonaMessages({ scenario: scenario.data, turns: history.data, question }),
    supabase,
    founderId,
  });
  if (!ai.ok) {
    // eslint-disable-next-line no-console
    console.error("rehearsal reply AI call failed", ai.error.kind);
    return turnFailure("ai_failed", AI_FAILURE_COPY[ai.error.kind], unanswered);
  }

  const guarded = guardReply(ai.text);
  if (!guarded.ok) {
    // A reply that breaks the product's rules is not stored: the founder sees the normal retry state.
    // eslint-disable-next-line no-console
    console.error("rehearsal reply rejected:", guarded.reason);
    return turnFailure(
      "invalid_output",
      "The practice customer's answer didn't come out right. Your question is saved. Try again.",
      unanswered,
    );
  }

  const storeCall = await admin.rpc("rehearsal_store_reply", {
    p_session: sessionId,
    p_seq: seq,
    p_reply: guarded.text,
  });
  const stored = StoreReplySchema.safeParse(storeCall.data);
  if (storeCall.error || !stored.success || !stored.data.ok) {
    // eslint-disable-next-line no-console
    console.error("rehearsal_store_reply failed", storeCall.error?.code ?? "unexpected result");
    return turnFailure("server_error", SERVER_ERROR_COPY, unanswered);
  }

  if (stored.data.stored === false) {
    // A parallel retry stored its reply first; show that one so the transcript stays consistent.
    const winner = await supabase
      .from("rehearsal_turns")
      .select("reply")
      .eq("session_id", sessionId)
      .eq("seq", seq)
      .maybeSingle<{ reply: string | null }>();
    return {
      ok: true,
      turn: { seq, question, reply: winner.data?.reply ?? guarded.text },
      ended: stored.data.ended === true,
    };
  }
  return { ok: true, turn: { seq, question, reply: guarded.text }, ended: stored.data.ended === true };
}

/** Saves the founder's next question (before any AI call), then gets the persona's reply. */
export async function sendTurn(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  founderId: string;
  sessionId: string;
  question: string;
}): Promise<TurnResult> {
  const { supabase, admin, founderId, sessionId, question } = params;

  const session = await getSession(supabase, sessionId);
  if (!session) return turnFailure("not_found", TURN_COPY.not_found);
  if (session.status !== "active") return turnFailure("not_active", TURN_COPY.not_active);

  const addCall = await admin.rpc("rehearsal_add_turn", { p_session: sessionId, p_question: question });
  if (addCall.error) {
    // eslint-disable-next-line no-console
    console.error("rehearsal_add_turn failed", addCall.error.code);
    return turnFailure("server_error", SERVER_ERROR_COPY);
  }
  const outcome = AddTurnSchema.safeParse(addCall.data);
  if (!outcome.success) return turnFailure("server_error", SERVER_ERROR_COPY);
  if (!outcome.data.ok || outcome.data.seq === undefined) {
    const code = outcome.data.code;
    if (code === "not_found" || code === "not_active" || code === "reply_pending" || code === "cap_reached") {
      return turnFailure(code, TURN_COPY[code]);
    }
    return turnFailure("server_error", SERVER_ERROR_COPY);
  }

  return generateReply({ supabase, admin, founderId, sessionId, seq: outcome.data.seq, question });
}

/** Re-requests the reply to the latest unanswered question. Never adds a turn, so the cap is not consumed twice. */
export async function retryReply(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  founderId: string;
  sessionId: string;
}): Promise<TurnResult> {
  const { supabase, admin, founderId, sessionId } = params;

  const session = await getSession(supabase, sessionId);
  if (!session) return turnFailure("not_found", TURN_COPY.not_found);
  if (session.status !== "active") return turnFailure("not_active", TURN_COPY.not_active);

  const latest = await supabase
    .from("rehearsal_turns")
    .select("seq, question, reply")
    .eq("session_id", sessionId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle<RehearsalTurn>();
  if (latest.error) return turnFailure("server_error", SERVER_ERROR_COPY);
  if (latest.data?.reply !== null) {
    return turnFailure("nothing_to_retry", TURN_COPY.nothing_to_retry);
  }

  return generateReply({ supabase, admin, founderId, sessionId, seq: latest.data.seq, question: latest.data.question });
}

// ---------------------------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------------------------
export type EndResult = { ok: true } | { ok: false; code: "not_found" | "server_error"; message: string };

/** Ends the founder's session early. Idempotent: ending an already-ended session succeeds. */
export async function endSession(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  sessionId: string;
}): Promise<EndResult> {
  const { supabase, admin, sessionId } = params;

  const session = await getSession(supabase, sessionId);
  if (!session) return { ok: false, code: "not_found", message: TURN_COPY.not_found };
  if (session.status === "ended") return { ok: true };

  const ended = await admin.rpc("rehearsal_end_session", { p_session: sessionId, p_reason: "user" });
  if (ended.error) {
    // eslint-disable-next-line no-console
    console.error("rehearsal_end_session failed", ended.error.code);
    return { ok: false, code: "server_error", message: SERVER_ERROR_COPY };
  }
  return { ok: true };
}
