import type { APIRoute } from "astro";
import { z } from "zod";
import { formToObject } from "@/lib/auth";
import { reviewInputSchema } from "@/lib/services/assumption-suggest";
import { reviewAssumption } from "@/lib/services/assumptions";
import { createClient } from "@/lib/supabase";

export const prerender = false;

// Accept (optionally with edited wording) or reject one pending suggestion (FR-010). The conditional update
// in reviewAssumption makes a repeated or racing decision a no-op that reports `not_pending`.
export const POST: APIRoute = async (context) => {
  if (!context.locals.user) return context.redirect("/auth/signin");

  const id = z.uuid().safeParse(context.params.id);
  if (!id.success) return context.redirect("/assumptions?reviewError=not_pending");

  const input = reviewInputSchema.safeParse(formToObject(await context.request.formData()));
  if (!input.success) return context.redirect("/assumptions?reviewError=invalid");

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) return context.redirect("/assumptions?reviewError=failed");

  const result = await reviewAssumption(supabase, id.data, input.data);
  return context.redirect(result.ok ? "/assumptions" : `/assumptions?reviewError=${result.code}`);
};
