import type { APIRoute } from "astro";
import { z } from "zod";
import { formToObject } from "@/lib/auth";
import { startSession } from "@/lib/services/rehearsal-service";
import { createClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabase-admin";

export const prerender = false;

// Starts a rehearsal on one active assumption. A plain form POST (like the other slow AI actions): success
// redirects into the session, failure adds ?startError=<code> so /rehearsal can explain it. Preparing the
// hidden practice customer is the slow part, so the form uses data-pending. If the project already has an
// active session the founder is taken to it instead of starting another.
export const POST: APIRoute = async (context) => {
  const { user } = context.locals;
  if (!user) return context.redirect("/auth/signin");

  const input = z.object({ assumptionId: z.uuid() }).safeParse(formToObject(await context.request.formData()));
  if (!input.success) return context.redirect("/rehearsal?startError=assumption_not_found");

  const supabase = createClient(context.request.headers, context.cookies);
  const admin = createServiceClient();
  if (!supabase || !admin) return context.redirect("/rehearsal?startError=server_error");

  const result = await startSession({ supabase, admin, founderId: user.id, assumptionId: input.data.assumptionId });
  return context.redirect(result.ok ? `/rehearsal/${result.sessionId}` : `/rehearsal?startError=${result.code}`);
};
