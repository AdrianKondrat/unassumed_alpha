import type { APIRoute } from "astro";
import { z } from "zod";
import { formToObject } from "@/lib/auth";
import { lifecycleInputSchema } from "@/lib/services/assumption-suggest";
import { setAssumptionStatus } from "@/lib/services/assumptions";
import { createClient } from "@/lib/supabase";

export const prerender = false;

// Sets an accepted assumption's lifecycle status by hand (FR-011). Pending and rejected rows can never be
// moved here: setAssumptionStatus only touches rows that are already active, superseded or retired.
export const POST: APIRoute = async (context) => {
  if (!context.locals.user) return context.redirect("/auth/signin");

  const id = z.uuid().safeParse(context.params.id);
  if (!id.success) return context.redirect("/assumptions?statusError=not_durable");

  const input = lifecycleInputSchema.safeParse(formToObject(await context.request.formData()));
  if (!input.success) return context.redirect("/assumptions?statusError=invalid");

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) return context.redirect("/assumptions?statusError=failed");

  const result = await setAssumptionStatus(supabase, id.data, input.data.status);
  return context.redirect(result.ok ? "/assumptions" : `/assumptions?statusError=${result.code}`);
};
