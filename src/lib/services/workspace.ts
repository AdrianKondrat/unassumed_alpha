import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "@/types";

/**
 * The signed-in founder's single personal workspace. RLS (`is_workspace_member`) does the filtering, so
 * the user-scoped client only ever sees their own row. Returns null if it is missing, which would mean the
 * signup trigger is broken.
 */
export async function getCurrentWorkspace(supabase: SupabaseClient): Promise<Workspace | null> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, name, created_at")
    .limit(1)
    .maybeSingle<Workspace>();

  if (error) {
    // eslint-disable-next-line no-console
    console.error("getCurrentWorkspace failed", error.code);
    return null;
  }
  return data;
}
