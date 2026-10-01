import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { errorRedirect, firstIssue, formToObject } from "@/lib/auth";
import { briefSchema } from "@/lib/services/canvas-draft";
import { createProject } from "@/lib/services/project";
import { z } from "zod";

export const prerender = false;

// Creates the founder's one project from a rough-notes brief (FR-005). The brief is saved here, before any
// AI call, so it can never be lost if drafting fails. Drafting is a separate request (./draft.ts).
export const POST: APIRoute = async (context) => {
  if (!context.locals.user) return context.redirect("/auth/signin");

  const parsed = z.object({ brief: briefSchema }).safeParse(formToObject(await context.request.formData()));
  if (!parsed.success) {
    return context.redirect(errorRedirect("/project/new", firstIssue(parsed.error)));
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(errorRedirect("/project/new", "Supabase is not configured"));
  }

  const result = await createProject(supabase, parsed.data.brief);
  if (!result.ok) {
    // A duplicate means the founder already has their project: send them to it rather than show an error.
    return context.redirect(
      result.code === "already_exists" ? "/project" : errorRedirect("/project/new", result.message),
    );
  }
  return context.redirect("/project");
};
