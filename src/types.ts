// Shared entity types and DTOs. Field names mirror database columns (snake_case) so rows from
// Supabase can be used as-is. Add new entities here instead of redefining them in components.

export interface Workspace {
  id: string;
  name: string;
  created_at: string;
}

export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  role: "owner";
  created_at: string;
}

export type CanvasBlockKey =
  | "key_partners"
  | "key_activities"
  | "key_resources"
  | "value_propositions"
  | "customer_relationships"
  | "channels"
  | "customer_segments"
  | "cost_structure"
  | "revenue_streams";

/** Who wrote a claim. AI-authored claims are always shown with an "AI draft" marker (FR-006). */
export type ClaimOrigin = "ai_draft" | "founder";

export interface Project {
  id: string;
  workspace_id: string;
  brief: string;
  draft_started_at: string | null;
  suggest_started_at: string | null;
  created_at: string;
}

export interface CanvasClaim {
  id: string;
  project_id: string;
  block: CanvasBlockKey;
  position: number;
  text: string;
  origin: ClaimOrigin;
  revision: number;
  created_at: string;
}

export type AssumptionStatus = "suggested" | "rejected" | "active" | "superseded" | "retired";

/** The three states a durable (accepted) assumption can be moved between by hand (FR-011). */
export type DurableAssumptionStatus = "active" | "superseded" | "retired";

export interface Assumption {
  id: string;
  project_id: string;
  statement: string;
  risk_note: string | null;
  status: AssumptionStatus;
  origin: "ai_suggested";
  /** True when the founder changed the AI's wording while accepting. */
  edited: boolean;
  created_at: string;
  updated_at: string;
}

export interface AssumptionClaimLink {
  assumption_id: string;
  claim_id: string;
}

export type RehearsalStatus = "active" | "ended";

/** Why a session ended. S-07 will add "expired". */
export type RehearsalEndReason = "user" | "cap";

export interface RehearsalSession {
  id: string;
  project_id: string;
  assumption_id: string;
  status: RehearsalStatus;
  ended_reason: RehearsalEndReason | null;
  created_at: string;
  ended_at: string | null;
}

/** One question and the persona's reply (null until it lands). Deliberately has no scenario field. */
export interface RehearsalTurn {
  seq: number;
  question: string;
  reply: string | null;
}

/** The five question-quality labels a scorecard can flag (FR-015). Each names a problem found. */
export type ScoreLabel = "leading" | "hypothetical" | "solution_biased" | "past_behavior" | "specificity";

export type ScorecardStatus = "scoring" | "ready" | "failed" | "insufficient";

export interface ScorecardFlag {
  seq: number;
  label: ScoreLabel;
  /** Exact founder text, copied from the stored turn by the database. */
  quote: string;
  explanation: string;
}

export interface ScorecardRewrite {
  seq: number;
  original: string;
  suggestion: string;
}

export interface Scorecard {
  session_id: string;
  status: ScorecardStatus;
  summary: string | null;
  error_kind: "timeout" | "ai_failed" | "invalid_output" | "server_error" | null;
  turns_scored: number;
  turns_flagged: number;
  flags: ScorecardFlag[];
  rewrites: ScorecardRewrite[];
}
