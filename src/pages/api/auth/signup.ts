import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { authErrorMessage, errorRedirect, firstIssue, formToObject, signUpSchema } from "@/lib/auth";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const parsed = signUpSchema.safeParse(formToObject(await context.request.formData()));
  if (!parsed.success) {
    return context.redirect(errorRedirect("/auth/signup", firstIssue(parsed.error)));
  }
  const { email, password } = parsed.data;

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(errorRedirect("/auth/signup", "Supabase is not configured"));
  }

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${context.url.origin}/auth/callback` },
  });

  // Weak password / rate limits are safe to surface. Everything else (including "already registered",
  // which Supabase obfuscates) gets the same "check your inbox" outcome so signup never reveals accounts.
  if (error && ["weak_password", "over_email_send_rate_limit", "over_request_rate_limit"].includes(error.code ?? "")) {
    return context.redirect(errorRedirect("/auth/signup", authErrorMessage(error)));
  }

  context.cookies.set("pending_email", email, {
    path: "/auth",
    httpOnly: true,
    sameSite: "lax",
    secure: context.url.protocol === "https:",
    maxAge: 60 * 60,
  });
  return context.redirect("/auth/confirm-email");
};
