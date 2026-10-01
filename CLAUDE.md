# Rules for AI

This file provides guidance to AI Agent when working with code in this repository.

## Commands

- `npm run dev` — start dev server (Cloudflare workerd runtime)
- `npm run build` — production build (SSR via `@astrojs/cloudflare`)
- `npm run preview` — preview production build
- `npm run lint` — ESLint with type-checked rules
- `npm run lint:fix` — auto-fix lint issues
- `npm run format` — Prettier (includes prettier-plugin-astro + prettier-plugin-tailwindcss)
- `npm run smoke` — dependency-free end-to-end auth smoke test (`scripts/smoke.mjs`) against a running server: signup, email verification and password reset by following the emailed links read from the local mail server. Env: `BASE_URL` (default `http://localhost:4321`), `MAIL_URL` (default `http://127.0.0.1:54324`). CI runs it against the production preview with a local Supabase.
- `npm run test:ai`, `npm run test:auth` — offline unit checks for the pure modules (`src/lib/ai-request.ts`, `src/lib/auth.ts`), run with `node --experimental-strip-types`. Each slice adds its own `test:*` script the same way.
- SQL assertions: `for f in supabase/tests/*.sql; do psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f "$f"; done` against a reset local DB (see `supabase/README.md`).

Pre-commit hooks: husky + lint-staged runs `eslint --fix` on `*.{ts,tsx,astro}` and `prettier --write` on `*.{json,css,md}`.

## Architecture

**Astro 7 SSR app** with React 19 islands, Tailwind 4, Supabase auth, and shadcn/ui components. Deployed to Cloudflare Workers.

### Rendering mode

Full server-side rendering (`output: "server"` in astro.config.mjs). All pages are server-rendered by default. API routes must export `const prerender = false`.

### Auth flow

- `src/lib/supabase.ts` — creates a Supabase SSR client using `@supabase/ssr` with cookie-based sessions. Uses `astro:env/server` for `SUPABASE_URL` and `SUPABASE_KEY` (server-only secrets declared in astro.config.mjs `env.schema`).
- `src/middleware.ts` — runs on every request, resolves the current user (treated as signed out unless `email_confirmed_at` is set), attaches to `context.locals.user`, redirects unauthenticated users away from routes in `PROTECTED_ROUTES`, and adds security + `no-store` headers. Every new founder page must be added to `PROTECTED_ROUTES`; API routes check `locals.user` themselves.
- Email verification is mandatory. Emails link to `/auth/callback?token_hash=…` (templates in `supabase/templates/`, verified with `verifyOtp`; works cross-device). `/auth/callback` also accepts a PKCE `?code=` as fallback and validates `next` with `safeNext()`.
- API endpoints: `src/pages/api/auth/{signin,signup,signout,resend,forgot-password,reset-password}.ts` (form POST → redirect with `?error=`; zod-validated; resend/forgot-password never reveal whether an account exists).
- Shared auth helpers (zod schemas, friendly error copy, `safeNext`): `src/lib/auth.ts`.
- Auth pages: `src/pages/auth/{signin,signup,confirm-email,forgot-password,reset-password}.astro`; signed-in home: `src/pages/dashboard.astro` (shows the founder's workspace via `src/lib/services/workspace.ts`).
- Each founder gets exactly one workspace + owner membership, created by the `on_auth_user_created` trigger (see `supabase/migrations/`). App code never inserts them.

### AI call path

- `src/lib/ai.ts` `complete({ taskKind, messages, supabase, founderId, … })` is the only way to call a model: OpenRouter with `provider.data_collection = "deny"` on every request, per-task model/timeout in `src/lib/ai-request.ts` (`TASK_CONFIG`), one retry, typed `AIResult`, one `ai_usage_events` row per success. Founder content and persona details must never be logged or returned to clients.

### UI / brand

- Brand tokens (paper/ink/yellow/red/teal, Archivo + JetBrains Mono, hard offset shadows, zero radius) live in `src/styles/global.css` with shared classes (`.btn`, `.card`, `.tag`, `.input`, `.label`, `.notice`, `.eyebrow`, `.slabel`, `.disp`). They mirror the marketing site. UK English copy; never use the words "validated" or "proven" about a founder's idea.

### Key conventions

- **Path alias**: `@/*` maps to `./src/*` (tsconfig paths).
- **Astro components** for static content/layout; **React components** only when interactivity is needed.
- **Tailwind class merging**: use the `cn()` helper from `@/lib/utils` (clsx + tailwind-merge) for conditional/merged class names. Do not concatenate class strings manually.
- **shadcn/ui**: components live in `src/components/ui/`, "new-york" style variant. Install new ones with `npx shadcn@latest add [name]`.
- **API routes**: use uppercase `GET`, `POST` exports; validate input with zod.
- **Supabase migrations**: `supabase/migrations/` using naming format `YYYYMMDDHHmmss_short_description.sql`. Always enable RLS on new tables with granular per-operation, per-role policies.
- **React**: no Next.js directives ("use client" etc.). Extract hooks to `src/components/hooks/`.
- **Services/helpers** go in `src/lib/` (or `src/lib/services/` for extracted business logic).
- **Shared types** (entities, DTOs) go in `src/types.ts`.

### Environment

- Node.js v22.14.0 (see `.nvmrc`)
- Env vars: `SUPABASE_URL`, `SUPABASE_KEY`, `OPENROUTER_API_KEY`, optional `OPENROUTER_BASE_URL` (copy `.env.example` to `.env` for Node, or `.dev.vars` for Cloudflare local dev)
- Local Supabase: `npx supabase start` (requires Docker)
- Cloudflare local dev: secrets go in `.dev.vars` (gitignored)
- Deploy: `npx wrangler deploy` (requires Cloudflare account + `wrangler` auth)

## CI

GitHub Actions (`.github/workflows/ci.yml`): `ci` (lint, astro check, offline tests, build), `smoke` (local Supabase + SQL assertions + production-preview smoke test) on pushes to `master`/`mvp` and PRs into `main`/`master`/`mvp`; `deploy` to the `unassumed-mvp` Worker only on pushes to `mvp` (see README "MVP deploy" for required secrets).
