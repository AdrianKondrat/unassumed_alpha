import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";
import { authErrorMessage, errorRedirect, safeNext } from "@/lib/auth";

export const prerender = false;

const tokenHashSchema = z.object({
  token_hash: z.string().min(8).max(512),
  type: z.enum(["email", "signup", "recovery"]),
});

/**
 * Landing point for emailed links (signup verification, password recovery).
 *
 * Primary path: the email templates (supabase/templates) link here with `?token_hash=…&type=…`, which we verify
 * server-side with `verifyOtp`. That works when the email is opened on a different browser or device.
 * Fallback: a PKCE `?code=` from Supabase's default links is exchanged for a session instead.
 */
export const GET: APIRoute = async (context) => {
  const params = context.url.searchParams;
  const next = safeNext(params.get("next"));
  const linkProblem = errorRedirect("/auth/signin", authErrorMessage({ code: "otp_expired" }));

  // Supabase reports link problems (expired, already used) as query params when it redirects here.
  if (params.get("error") ?? params.get("error_code")) {
    return context.redirect(
      errorRedirect("/auth/signin", authErrorMessage({ code: params.get("error_code") ?? "otp_expired" })),
    );
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(errorRedirect("/auth/signin", "Supabase is not configured"));
  }

  if (params.has("token_hash")) {
    const parsed = tokenHashSchema.safeParse({ token_hash: params.get("token_hash"), type: params.get("type") });
    if (!parsed.success) return context.redirect(linkProblem);

    const { error } = await supabase.auth.verifyOtp({ type: parsed.data.type, token_hash: parsed.data.token_hash });
    if (error) {
      return context.redirect(errorRedirect("/auth/signin", authErrorMessage({ code: error.code ?? "otp_expired" })));
    }
  } else {
    const code = params.get("code");
    if (!code) return context.redirect(linkProblem);

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return context.redirect(errorRedirect("/auth/signin", authErrorMessage(error)));
    }
  }

  context.cookies.delete("pending_email", { path: "/auth" });
  return context.redirect(next);
};
