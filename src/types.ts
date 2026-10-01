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
