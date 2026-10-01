import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { emailOnlySchema, errorRedirect, firstIssue, formToObject } from "@/lib/auth";

export const prerender = false;

/** Re-sends the verification email. Always ends on the same generic page, whatever the outcome. */
export const POST: APIRoute = async (context) => {
  const parsed = emailOnlySchema.safeParse(formToObject(await context.request.formData()));
  if (!parsed.success) {
    return context.redirect(errorRedirect("/auth/confirm-email", firstIssue(parsed.error)));
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(errorRedirect("/auth/confirm-email", "Supabase is not configured"));
  }

  await supabase.auth.resend({
    type: "signup",
    email: parsed.data.email,
    options: { emailRedirectTo: `${context.url.origin}/auth/callback` },
  });

  context.cookies.set("pending_email", parsed.data.email, {
    path: "/auth",
    httpOnly: true,
    sameSite: "lax",
    secure: context.url.protocol === "https:",
    maxAge: 60 * 60,
  });
  return context.redirect("/auth/confirm-email?sent=1");
};
