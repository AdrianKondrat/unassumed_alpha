/**
 * Worker entry point.
 *
 * Static assets are matched first by the assets pipeline (see wrangler.jsonc),
 * so this only runs for `/api/*` and for paths with no matching file.
 */
import type { Env } from "./env";
import { handleWaitlist } from "./waitlist";
import { jsonResponse } from "./security";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/waitlist") {
      if (request.method !== "POST") {
        return jsonResponse({ ok: false, message: "Method not allowed." }, 405);
      }
      return handleWaitlist(request, env, ctx);
    }

    if (pathname.startsWith("/api/")) {
      return jsonResponse({ ok: false, message: "Not found." }, 404);
    }

    // Anything else with no matching asset: serve our own 404 page, with the
    // status corrected (the assets fetch returns 200 for an explicit path).
    const notFound = await env.ASSETS.fetch(new URL("/404", request.url));
    return new Response(notFound.body, {
      status: 404,
      headers: notFound.headers,
    });
  },
} satisfies ExportedHandler<Env>;
