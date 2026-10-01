// RLS-scoped reads for rehearsal pages and routes. Uses only the founder's own client, so it can never see
// (or leak) the hidden scenario: founders have no privilege on that table at all. Writes and the scenario live
// in ./rehearsal-service.ts behind the service-role client.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RehearsalSession, RehearsalTurn } from "@/types";

const SESSION_COLUMNS = "id, project_id, assumption_id, status, ended_reason, created_at, ended_at";

export async function getSession(supabase: SupabaseClient, id: string): Promise<RehearsalSession | null> {
  const { data, error } = await supabase
    .from("rehearsal_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", id)
    .maybeSingle<RehearsalSession>();
  if (error) {
    // eslint-disable-next-line no-console
    console.error("getSession failed", error.code);
    return null;
  }
  return data;
}

export async function getActiveSession(supabase: SupabaseClient, projectId: string): Promise<RehearsalSession | null> {
  const { data, error } = await supabase
    .from("rehearsal_sessions")
    .select(SESSION_COLUMNS)
    .eq("project_id", projectId)
    .eq("status", "active")
    .maybeSingle<RehearsalSession>();
  if (error) {
    // eslint-disable-next-line no-console
    console.error("getActiveSession failed", error.code);
    return null;
  }
  return data;
}

/** Every saved question with its reply (null while waiting), in order. Only these three fields ever leave. */
export async function listTurns(supabase: SupabaseClient, sessionId: string): Promise<RehearsalTurn[]> {
  const { data, error } = await supabase
    .from("rehearsal_turns")
    .select("seq, question, reply")
    .eq("session_id", sessionId)
    .order("seq", { ascending: true })
    .overrideTypes<RehearsalTurn[], { merge: false }>();
  if (error) {
    // eslint-disable-next-line no-console
    console.error("listTurns failed", error.code);
    return [];
  }
  return data;
}

export interface RehearsableAssumption {
  id: string;
  statement: string;
  risk_note: string | null;
}

/** Assumptions the founder has kept and not retired or superseded: the only ones that can be rehearsed. */
export async function listRehearsableAssumptions(
  supabase: SupabaseClient,
  projectId: string,
): Promise<RehearsableAssumption[]> {
  const { data, error } = await supabase
    .from("assumptions")
    .select("id, statement, risk_note")
    .eq("project_id", projectId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .overrideTypes<RehearsableAssumption[], { merge: false }>();
  if (error) {
    // eslint-disable-next-line no-console
    console.error("listRehearsableAssumptions failed", error.code);
    return [];
  }
  return data;
}

export interface SessionSummary extends RehearsalSession {
  assumption_statement: string;
  turn_count: number;
}

interface SessionSummaryRow extends RehearsalSession {
  assumptions: { statement: string } | null;
  rehearsal_turns: { count: number }[];
}

/** The project's sessions, newest first, each with its assumption's wording and how many questions it holds. */
export async function listSessions(supabase: SupabaseClient, projectId: string): Promise<SessionSummary[]> {
  const { data, error } = await supabase
    .from("rehearsal_sessions")
    .select(`${SESSION_COLUMNS}, assumptions(statement), rehearsal_turns(count)`)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .overrideTypes<SessionSummaryRow[], { merge: false }>();
  if (error) {
    // eslint-disable-next-line no-console
    console.error("listSessions failed", error.code);
    return [];
  }
  return data.map(({ assumptions, rehearsal_turns, ...session }) => ({
    ...session,
    assumption_statement: assumptions?.statement ?? "",
    turn_count: rehearsal_turns[0]?.count ?? 0,
  }));
}

/** The statement a session rehearses (the wording is frozen once an assumption is kept). */
export async function getAssumptionStatement(supabase: SupabaseClient, assumptionId: string): Promise<string> {
  const { data, error } = await supabase
    .from("assumptions")
    .select("statement")
    .eq("id", assumptionId)
    .maybeSingle<{ statement: string }>();
  if (error) {
    // eslint-disable-next-line no-console
    console.error("getAssumptionStatement failed", error.code);
    return "";
  }
  return data?.statement ?? "";
}
