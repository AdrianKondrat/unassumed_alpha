// @ts-check
import { defineConfig, envField } from "astro/config";

import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  output: "server",
  security: {
    // Astro hashes its own inline island/hydration scripts and styles, so no 'unsafe-inline' is needed. Everything
    // else is same-origin: fonts and images are self-hosted, the browser only ever talks to this origin (Supabase and
    // OpenRouter are called from the server), and forms only post back here.
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
    },
  },
  integrations: [react(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
  adapter: cloudflare(),
  env: {
    schema: {
      SUPABASE_URL: envField.string({ context: "server", access: "secret", optional: true }),
      SUPABASE_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      // Server-only privileged key (bypasses RLS). Used only by src/lib/supabase-admin.ts for the hidden
      // rehearsal persona tables; never expose it to a page, island or response.
      SUPABASE_SERVICE_ROLE_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      OPENROUTER_API_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      // Optional: point the AI call path at another OpenRouter-compatible endpoint (local fakes, proxies).
      OPENROUTER_BASE_URL: envField.string({ context: "server", access: "secret", optional: true }),
    },
  },
});
