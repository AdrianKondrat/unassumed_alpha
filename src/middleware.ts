import { defineMiddleware } from "astro:middleware";
import { createClient } from "@/lib/supabase";

// Pages that require a signed-in, email-verified founder. Prefix match. API routes check `locals.user` themselves.
const PROTECTED_ROUTES = ["/dashboard", "/auth/reset-password"];

export const onRequest = defineMiddleware(async (context, next) => {
  const supabase = createClient(context.request.headers, context.cookies);

  if (supabase) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // Defence in depth for FR-001: an unverified account is treated as signed out even if Supabase issued a session.
    context.locals.user = user?.email_confirmed_at ? user : null;
  } else {
    context.locals.user = null;
  }

  const isProtected = PROTECTED_ROUTES.some((route) => context.url.pathname.startsWith(route));
  if (isProtected && !context.locals.user) {
    return context.redirect("/auth/signin");
  }

  const response = await next();

  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (context.url.protocol === "https:") {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
  // Founder content must never be cached by shared caches or the back/forward cache of a shared machine.
  if (context.locals.user || isProtected || context.url.pathname.startsWith("/api/")) {
    response.headers.set("Cache-Control", "private, no-store");
  }

  return response;
});
