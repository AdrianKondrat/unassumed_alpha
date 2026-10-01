import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { suggestAssumptions } from "@/lib/services/assumption-suggest-service";
import { getCurrentProject } from "@/lib/services/project";

export const prerender = false;

// Asks the AI for a batch of candidate assumptions for the caller's project. Always redirects back to
// /assumptions: success shows the pending cards, failure adds ?suggestError=<code> so the page can explain it
// and offer Retry. The guards (canvas exists, no unreviewed batch, in-flight lease) live in the service, so
// a double-click or a second tab cannot spend twice or create two batches.
export const POST: APIRoute = async (context) => {
  const { user } = context.locals;
  if (!user) return context.redirect("/auth/signin");

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) return context.redirect("/assumptions?suggestError=ai_failed");

  const project = await getCurrentProject(supabase);
  if (!project) return context.redirect("/project/new");

  const result = await suggestAssumptions({ supabase, founderId: user.id, projectId: project.id });
  if (result.ok || result.code === "pending_batch" || result.code === "in_progress") {
    return context.redirect("/assumptions");
  }
  return context.redirect(`/assumptions?suggestError=${result.code}`);
};
