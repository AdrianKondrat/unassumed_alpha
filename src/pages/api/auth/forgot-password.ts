import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { emailOnlySchema, errorRedirect, firstIssue, formToObject } from "@/lib/auth";

export const prerender = false;

/** Sends a recovery email. Always ends on the same generic confirmation, whether or not the account exists. */
export const POST: APIRoute = async (context) => {
  const parsed = emailOnlySchema.safeParse(formToObject(await context.request.formData()));
  if (!parsed.success) {
    return context.redirect(errorRedirect("/auth/forgot-password", firstIssue(parsed.error)));
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(errorRedirect("/auth/forgot-password", "Supabase is not configured"));
  }

  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${context.url.origin}/auth/callback?next=/auth/reset-password`,
  });

  return context.redirect("/auth/forgot-password?sent=1");
};
