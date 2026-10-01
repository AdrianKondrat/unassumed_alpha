import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { draftCanvas } from "@/lib/services/canvas-draft-service";
import { getCurrentProject } from "@/lib/services/project";

export const prerender = false;

// Drafts the canvas for the caller's project. Always redirects back to /project: success shows the canvas,
// failure adds ?draftError=<code> so the page can explain it and offer Retry. The race protocol (lease,
// existing-claims check) lives in draftCanvas, so a double-click or a second tab cannot draft twice.
export const POST: APIRoute = async (context) => {
  const { user } = context.locals;
  if (!user) return context.redirect("/auth/signin");

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) return context.redirect("/project?draftError=ai_failed");

  const project = await getCurrentProject(supabase);
  if (!project) return context.redirect("/project/new");

  const result = await draftCanvas({ supabase, founderId: user.id, projectId: project.id });
  if (result.ok || result.code === "already_drafted" || result.code === "in_progress") {
    return context.redirect("/project");
  }
  return context.redirect(`/project?draftError=${result.code}`);
};
