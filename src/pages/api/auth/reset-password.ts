import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { authErrorMessage, errorRedirect, firstIssue, formToObject, resetPasswordSchema } from "@/lib/auth";

export const prerender = false;

/** Sets a new password for the signed-in (recovery) session. */
export const POST: APIRoute = async (context) => {
  if (!context.locals.user) {
    return context.redirect(errorRedirect("/auth/signin", "Your session has expired. Sign in again."));
  }

  const parsed = resetPasswordSchema.safeParse(formToObject(await context.request.formData()));
  if (!parsed.success) {
    return context.redirect(errorRedirect("/auth/reset-password", firstIssue(parsed.error)));
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(errorRedirect("/auth/reset-password", "Supabase is not configured"));
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return context.redirect(errorRedirect("/auth/reset-password", authErrorMessage(error)));
  }

  // The password changed, so end every other session (e.g. whoever else held the old password).
  await supabase.auth.signOut({ scope: "others" });

  return context.redirect("/dashboard?passwordChanged=1");
};
