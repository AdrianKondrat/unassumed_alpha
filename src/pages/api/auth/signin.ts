import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { authErrorMessage, errorRedirect, firstIssue, formToObject, signInSchema } from "@/lib/auth";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const parsed = signInSchema.safeParse(formToObject(await context.request.formData()));
  if (!parsed.success) {
    return context.redirect(errorRedirect("/auth/signin", firstIssue(parsed.error)));
  }
  const { email, password } = parsed.data;

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(errorRedirect("/auth/signin", "Supabase is not configured"));
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    if (error.code === "email_not_confirmed") {
      // Only reachable with the correct password, so this does not reveal arbitrary accounts.
      context.cookies.set("pending_email", email, {
        path: "/auth",
        httpOnly: true,
        sameSite: "lax",
        secure: context.url.protocol === "https:",
        maxAge: 60 * 60,
      });
      return context.redirect("/auth/confirm-email?unverified=1");
    }
    return context.redirect(errorRedirect("/auth/signin", authErrorMessage(error)));
  }

  return context.redirect("/dashboard");
};
