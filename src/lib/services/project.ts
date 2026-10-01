import type { SupabaseClient } from "@supabase/supabase-js";
import type { CanvasClaim, Project } from "@/types";
import { getCurrentWorkspace } from "./workspace";

const PROJECT_COLUMNS = "id, workspace_id, brief, draft_started_at, created_at";
const CLAIM_COLUMNS = "id, project_id, block, position, text, origin, revision, created_at";

/** The founder's one project (RLS scopes the query to their workspace), or null if they have not made it yet. */
export async function getCurrentProject(supabase: SupabaseClient): Promise<Project | null> {
  const { data, error } = await supabase.from("projects").select(PROJECT_COLUMNS).limit(1).maybeSingle<Project>();
  if (error) {
    // eslint-disable-next-line no-console
    console.error("getCurrentProject failed", error.code);
    return null;
  }
  return data;
}

export async function listClaims(supabase: SupabaseClient, projectId: string): Promise<CanvasClaim[]> {
  const { data, error } = await supabase
    .from("canvas_claims")
    .select(CLAIM_COLUMNS)
    .eq("project_id", projectId)
    .order("position", { ascending: true })
    .overrideTypes<CanvasClaim[], { merge: false }>();
  if (error) {
    // eslint-disable-next-line no-console
    console.error("listClaims failed", error.code);
    return [];
  }
  return data;
}

export type CreateProjectResult =
  { ok: true; project: Project } | { ok: false; code: "already_exists" | "no_workspace" | "failed"; message: string };

/**
 * Persists the brief as the founder's one project (FR-005). The brief is saved before any AI call so it is
 * never lost; the one-project cap is the database's unique constraint on `workspace_id`, mapped here to a
 * friendly message.
 */
export async function createProject(supabase: SupabaseClient, brief: string): Promise<CreateProjectResult> {
  const workspace = await getCurrentWorkspace(supabase);
  if (!workspace) {
    return { ok: false, code: "no_workspace", message: "We couldn't find your workspace. Refresh and try again." };
  }

  const { data, error } = await supabase
    .from("projects")
    .insert({ workspace_id: workspace.id, brief })
    .select(PROJECT_COLUMNS)
    .single<Project>();

  if (error) {
    if (error.code === "23505") {
      return { ok: false, code: "already_exists", message: "You already have a project. This release supports one." };
    }
    // eslint-disable-next-line no-console
    console.error("createProject failed", error.code);
    return { ok: false, code: "failed", message: "We couldn't save your brief. Please try again." };
  }
  return { ok: true, project: data };
}
