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
import type { RehearsalSession, RehearsalTurn } from "@/types";
import {
  REHEARSAL_TURN_CAP,
  ScenarioSchema,
  buildPersonaMessages,
  buildScenarioMessages,
  guardReply,
  parseScenario,
} from "./rehearsal-persona";
import type { PriorTurn } from "./rehearsal-persona";
import { classifyTurn, isSessionExpired, resolveReplay } from "./rehearsal-resume";
import type { PendingState } from "./rehearsal-resume";
import { getActiveSession, getSession, listTurnsForState } from "./rehearsals";
import type { StateTurn } from "./rehearsals";

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

  // A session idle for more than 24 h is ended first, so a stale one never blocks a new start.
  await expireIdleSessions(admin, assumption.project_id);
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
// Idle expiry
// ---------------------------------------------------------------------------------------------
/** Ends the project's active session if it has been idle for more than 24 h. Safe to call on every start and list. */
export async function expireIdleSessions(admin: SupabaseClient, projectId: string): Promise<void> {
  const { error } = await admin.rpc("rehearsal_expire_idle", { p_project: projectId });
  // eslint-disable-next-line no-console
  if (error) console.error("rehearsal_expire_idle failed", error.code);
}

/**
 * The founder's session with idle expiry applied. The database decides expiry with its own clock; the app-side
 * check only avoids calling it for sessions that cannot be stale. A session that is not the founder's is null.
 */
async function loadSession(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  sessionId: string,
): Promise<RehearsalSession | null> {
  const session = await getSession(supabase, sessionId);
  if (!session) return null;
  const idle = isSessionExpired({
    status: session.status,
    lastActivityAt: session.last_activity_at,
    now: Date.now(),
  });
  if (!idle) return session;
  await expireIdleSessions(admin, session.project_id);
  return (await getSession(supabase, sessionId)) ?? session;
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
  /** `pending` means another request is still generating this turn's reply: show it as waiting and poll. */
  | { ok: true; turn: RehearsalTurn; ended: boolean; pending?: boolean }
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
const AddTurnSchema = z.object({
  ok: z.boolean(),
  seq: z.number().int().optional(),
  replay: z.boolean().optional(),
  code: z.string().optional(),
});
const StoreReplySchema = z.object({ ok: z.boolean(), stored: z.boolean().optional(), ended: z.boolean().optional() });
const ClaimSchema = z.enum(["claimed", "answered", "in_flight", "not_found"]);

/** Produces and stores the persona's reply to one claimed turn. The question is never lost on failure. */
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
    // A parallel request stored its reply first; show that one so the transcript stays consistent.
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

/**
 * Takes the reply lease for one saved turn and generates its reply, or reports what the other holder is doing.
 * On any failure the lease is handed back, so Retry works immediately instead of after the lease runs out. On
 * success the database clears it together with storing the reply.
 */
async function resumeTurn(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  founderId: string;
  sessionId: string;
  turn: RehearsalTurn;
}): Promise<TurnResult> {
  const { supabase, admin, sessionId, turn } = params;

  const claimCall = await admin.rpc("rehearsal_claim_reply", { p_session: sessionId, p_seq: turn.seq });
  const claim = ClaimSchema.safeParse(claimCall.data);
  if (claimCall.error || !claim.success) {
    // eslint-disable-next-line no-console
    console.error("rehearsal_claim_reply failed", claimCall.error?.code ?? "unexpected result");
    return turnFailure("server_error", SERVER_ERROR_COPY, turn);
  }
  switch (claim.data) {
    case "in_flight":
      return { ok: true, turn, ended: false, pending: true };
    case "not_found":
      return turnFailure("server_error", SERVER_ERROR_COPY, turn);
    case "answered": {
      // Another request finished it between our read and our claim: hand back what it stored.
      const fresh = await supabase
        .from("rehearsal_turns")
        .select("seq, question, reply")
        .eq("session_id", sessionId)
        .eq("seq", turn.seq)
        .maybeSingle<RehearsalTurn>();
      if (fresh.error || !fresh.data) return turnFailure("server_error", SERVER_ERROR_COPY, turn);
      return { ok: true, turn: fresh.data, ended: await endedAtCap(supabase, sessionId, turn.seq) };
    }
    case "claimed":
      break;
  }

  const result = await generateReply({ ...params, seq: turn.seq, question: turn.question });
  if (!result.ok) {
    const released = await admin.rpc("rehearsal_release_reply", { p_session: sessionId, p_seq: turn.seq });
    // eslint-disable-next-line no-console
    if (released.error) console.error("rehearsal_release_reply failed", released.error.code);
  }
  return result;
}

/** True when the 8th reply landed and ended the session at the cap (so the client can show the ended state). */
async function endedAtCap(supabase: SupabaseClient, sessionId: string, seq: number): Promise<boolean> {
  if (seq < REHEARSAL_TURN_CAP) return false;
  const session = await getSession(supabase, sessionId);
  return session?.status === "ended" && session.ended_reason === "cap";
}

/**
 * Saves the founder's next question (before any AI call), then gets the persona's reply. `clientKey` makes the
 * send idempotent: the same key again (a lost response, a double click, a refresh) returns the saved turn
 * instead of adding another, waits if its reply is being generated elsewhere, and resumes the generation if
 * the request that was producing it is gone.
 */
export async function sendTurn(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  founderId: string;
  sessionId: string;
  question: string;
  clientKey: string;
}): Promise<TurnResult> {
  const { supabase, admin, founderId, sessionId, question, clientKey } = params;

  // Ownership first: a session the founder cannot see is simply not found. Status is NOT checked here: a replayed
  // key must still resolve after the session ended (a lost response to the 8th question), and the database
  // decides everything else (expiry, cap, pending) under its row lock.
  const session = await getSession(supabase, sessionId);
  if (!session) return turnFailure("not_found", TURN_COPY.not_found);

  const addCall = await admin.rpc("rehearsal_add_turn", {
    p_session: sessionId,
    p_question: question,
    p_client_key: clientKey,
  });
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

  // The saved turn is the truth (on a replay it may differ from the text just sent).
  const saved = await supabase
    .from("rehearsal_turns")
    .select("seq, question, reply, reply_started_at")
    .eq("session_id", sessionId)
    .eq("seq", outcome.data.seq)
    .maybeSingle<RehearsalTurn & { reply_started_at: string | null }>();
  if (saved.error || !saved.data) return turnFailure("server_error", SERVER_ERROR_COPY);
  const turn: RehearsalTurn = { seq: saved.data.seq, question: saved.data.question, reply: saved.data.reply };

  if (outcome.data.replay === true) {
    const next = resolveReplay({
      reply: turn.reply,
      replyStartedAt: saved.data.reply_started_at,
      now: Date.now(),
    });
    if (next === "answered") return { ok: true, turn, ended: await endedAtCap(supabase, sessionId, turn.seq) };
    if (next === "wait") return { ok: true, turn, ended: false, pending: true };
  }
  return resumeTurn({ supabase, admin, founderId, sessionId, turn });
}

/** Re-requests the reply to the latest unanswered question. Never adds a turn, so the cap is not consumed twice. */
export async function retryReply(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  founderId: string;
  sessionId: string;
}): Promise<TurnResult> {
  const { supabase, admin, founderId, sessionId } = params;

  const session = await loadSession(supabase, admin, sessionId);
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

  // The claim decides who generates: a retry that finds a live request answers "pending" instead of racing it.
  return resumeTurn({ supabase, admin, founderId, sessionId, turn: latest.data });
}

// ---------------------------------------------------------------------------------------------
// State (resume)
// ---------------------------------------------------------------------------------------------
export type SessionState =
  | {
      kind: "ok";
      session: RehearsalSession;
      turns: StateTurn[];
      /** What to do about the latest turn when it has no reply; null when it is answered or there are no turns. */
      pending: PendingState | null;
    }
  | { kind: "not_found" }
  /** The read failed; callers must not treat this as an empty session. */
  | { kind: "error" };

/**
 * Everything a client needs to resume: the session (with idle expiry applied), every saved turn once, and what
 * is happening to the latest unanswered one. Read-only for the founder's data: it never moves
 * `last_activity_at`, so polling cannot keep a session alive.
 */
export async function getSessionState(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  sessionId: string;
}): Promise<SessionState> {
  const { supabase, admin, sessionId } = params;
  const session = await loadSession(supabase, admin, sessionId);
  if (!session) return { kind: "not_found" };
  const turns = await listTurnsForState(supabase, sessionId);
  if (!turns) return { kind: "error" };

  const last = turns.at(-1);
  const state = last
    ? classifyTurn({ reply: last.reply, replyStartedAt: last.reply_started_at, now: Date.now() })
    : null;
  return { kind: "ok", session, turns, pending: state === null || state === "answered" ? null : state };
}

// ---------------------------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------------------------
export type EndResult = { ok: true } | { ok: false; code: "not_found" | "server_error"; message: string };

/** Ends the founder's session early. Idempotent: ending an already-ended (or expired) session succeeds. */
export async function endSession(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  sessionId: string;
}): Promise<EndResult> {
  const { supabase, admin, sessionId } = params;

  const session = await loadSession(supabase, admin, sessionId);
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
