// RLS-scoped reads for the scorecard page and routes. Founders can only SELECT scorecards, flags and rewrites
// of their own sessions; writes live in ./scorecard-service.ts behind the service-role client.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Scorecard, ScorecardFlag, ScorecardRewrite } from "@/types";

type ScorecardRow = Omit<Scorecard, "flags" | "rewrites">;

/** The session's scorecard with its flags and rewrites, or null when there is none yet (or it is not theirs). */
export async function getScorecard(supabase: SupabaseClient, sessionId: string): Promise<Scorecard | null> {
  const { data: card, error } = await supabase
    .from("scorecards")
    .select("session_id, status, summary, error_kind, turns_scored, turns_flagged")
    .eq("session_id", sessionId)
    .maybeSingle<ScorecardRow>();
  if (error) {
    // eslint-disable-next-line no-console
    console.error("getScorecard failed", error.code);
    return null;
  }
  if (!card) return null;
  if (card.status !== "ready") return { ...card, flags: [], rewrites: [] };

  const [flags, rewrites] = await Promise.all([
    supabase
      .from("scorecard_flags")
      .select("seq, label, quote, explanation")
      .eq("session_id", sessionId)
      .order("seq", { ascending: true })
      .overrideTypes<ScorecardFlag[], { merge: false }>(),
    supabase
      .from("scorecard_rewrites")
      .select("seq, original, suggestion")
      .eq("session_id", sessionId)
      .order("seq", { ascending: true })
      .overrideTypes<ScorecardRewrite[], { merge: false }>(),
  ]);
  if (flags.error || rewrites.error) {
    // eslint-disable-next-line no-console
    console.error("getScorecard children failed", flags.error?.code ?? rewrites.error?.code);
    return null;
  }
  return { ...card, flags: flags.data, rewrites: rewrites.data };
}
