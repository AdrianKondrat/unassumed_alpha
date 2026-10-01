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
