# Rules for AI

This file provides guidance to AI Agent when working with code in this repository.

## Commands

- `npm run dev` — start dev server (Cloudflare workerd runtime)
- `npm run build` — production build (SSR via `@astrojs/cloudflare`)
- `npm run preview` — preview production build
- `npm run lint` — ESLint with type-checked rules
- `npm run lint:fix` — auto-fix lint issues
- `npm run format` — Prettier (includes prettier-plugin-astro + prettier-plugin-tailwindcss)
- `npm run smoke` — dependency-free end-to-end smoke test (`scripts/smoke.mjs`) against a running server: auth (signup, email verification, password reset by following emailed links) and, when `FAKE_AI_URL` is set, the product flow against `scripts/fake-openrouter.mjs` (run it on :4010 and start the app with `OPENROUTER_BASE_URL=http://127.0.0.1:4010/v1`; it has `/__mode`, `/__calls`, `/__reset` controls and each AI slice registers a handler there). Env: `BASE_URL` (default `http://localhost:4321`), `MAIL_URL` (default `http://127.0.0.1:54324`), optional `SUPABASE_URL` + `SUPABASE_ANON_KEY` (enables the check that a founder's own token cannot read or write the hidden persona through the real PostgREST), optional `DATABASE_URL` (a Postgres URL; enables the S-07 steps that age a session or a reply lease with psql, which no client can do). CI runs it against the production preview with a local Supabase.
- `npm run test:ai`, `npm run test:auth`, `npm run test:canvas`, `npm run test:assumptions`, `npm run test:rehearsal`, `npm run test:scorecard`, `npm run test:rehearsal-resume` — offline unit checks for the pure modules (`src/lib/ai-request.ts`, `src/lib/auth.ts`, `src/lib/ai-output.ts` + `src/lib/services/canvas-draft.ts`, `src/lib/services/assumption-suggest.ts`, `src/lib/services/rehearsal-persona.ts` + `rehearsal-http.ts`, `src/lib/services/scorecard.ts` + `scorecard-run.ts`, `src/lib/services/rehearsal-resume.ts`), run with `node --experimental-strip-types`. Each slice adds its own `test:*` script the same way.
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

### Project and canvas (S-02)

- Tables `projects` (one per workspace, unique `workspace_id`) and `canvas_claims` (9-block vocabulary, `origin` = `ai_draft | founder`, `revision`). `public.is_project_member(project uuid)` is the RLS helper for everything that hangs off a project; `public.claim_draft_lease(project uuid)` is the atomic in-flight lease (60 s staleness, DB clock). Do **not** build leases as a PostgREST `update` with `or=` + `select`: it fails on PostgREST 12.2.3. Use a function.
- Pure modules: `src/lib/ai-output.ts` (`extractJson`, `findForbiddenWording`, `NO_VIABILITY_CLAIMS_RULE`; shared by all AI slices) and `src/lib/services/canvas-draft.ts` (blocks, prompt, zod schema, `parseDraft`, `briefSchema`). Orchestration: `canvas-draft-service.ts` (`draftCanvas`), `project.ts` (`getCurrentProject`, `listClaims`, `createProject`).
- Routes: `POST /api/projects` (save brief first), `POST /api/projects/draft` (redirects to `/project`, `?draftError=<code>` on failure; only known codes are rendered). Pages: `/project/new`, `/project`; components in `src/components/canvas/`. Slow AI forms use `data-pending` + `src/scripts/pending-forms.ts`.

### Assumptions (S-04)

- Table `assumptions` holds pending candidates and durable assumptions, told apart by `status` (`suggested` → `active | rejected`; `active | superseded | retired` move freely; `rejected` is terminal); `assumption_claims` records provenance. Rules are enforced by the `assumptions_guard` trigger (and the routes' conditional updates), so direct API writes cannot bypass the review gate. Rehearsal (S-05) should pick from `status = 'active'` and use the `statement` column.
- DB functions: `claim_suggest_lease(project)` (lease, like the draft one) and `create_suggested_assumptions(project, items jsonb)` (atomic batch + links). Use `clock_timestamp()` for defaults when row order within one transaction matters.
- Pure module `src/lib/services/assumption-suggest.ts` (prompt, parser, form schemas, `computeReviewUpdate`, `canReview`/`canSetLifecycle`); orchestration in `assumption-suggest-service.ts`; reads/writes in `assumptions.ts`. Routes: `POST /api/assumptions/suggest`, `POST /api/assumptions/[id]/review` (`accept`/`reject`, absent fields mean keep), `POST /api/assumptions/[id]/status`. Page `/assumptions`, components in `src/components/assumptions/`.

### Rehearsal (S-05)

- Tables `rehearsal_sessions` (`status active | ended`, `ended_reason user | cap`, one active per project), `rehearsal_turns` (`seq` 1..8, `question`, `reply`) and `rehearsal_scenarios` (the hidden persona). Founders have `SELECT` only on sessions and turns and **no privilege** on scenarios (RLS on, no policies, revoked from `anon` and `authenticated`). Never add a scenario type to `src/types.ts` or select the scenario with an RLS client.
- All writes are service-role-only DB functions: `start_rehearsal_session`, `rehearsal_add_turn` (row lock; decides pending / cap / not-active and assigns `seq`), `rehearsal_store_reply` (auto-ends at the 8th reply), `rehearsal_end_session`. Their `EXECUTE` is revoked from `anon`/`authenticated`; Supabase grants new functions to every role by default, so always revoke explicitly.
- Two clients: the founder's RLS client proves ownership and is the one passed to `complete()`; `src/lib/supabase-admin.ts` (`createServiceClient()`, needs `SUPABASE_SERVICE_ROLE_KEY`) is server-only and used only for scenario reads and the four functions, after an RLS read proved ownership. Never import it from a page's props or an island.
- Pure modules `src/lib/services/rehearsal-persona.ts` (cap, scenario prompt/schema/parser, persona prompt, `guardReply`, `questionSchema`) and `rehearsal-http.ts` (status mapping, `toPublicTurn` allow-list, content-type gate); orchestration `rehearsal-service.ts` (`startSession`, `sendTurn`, `retryReply`, `endSession`, RPC payloads validated with zod); RLS-only reads `rehearsals.ts`; route plumbing `rehearsal-route.ts`.
- Routes: `POST /api/rehearsal/sessions` (form, `assumptionId`, redirects, `?startError=<code>`), JSON `POST /api/rehearsal/sessions/[id]/turns | retry | end` (401 / 400 / 404 / 409 / 415 / 502; require `application/json`; bodies only `seq`, `question`, `reply`, `ended`, codes). Pages `/rehearsal` (pick, continue, past sessions) and `/rehearsal/[id]` with the React island `src/components/rehearsal/RehearsalChat.tsx` and hook `src/components/hooks/useRehearsalSession.ts`.
- Reply guard: a persona reply with "validated"/"proven", endorsement wording or a setup leak is never stored; the turn stays reply-less and shows Retry. Retry never inserts a turn.

### Scorecard (S-06)

- Tables `scorecards` (one per session; `status scoring | ready | failed | insufficient`, `error_kind`, `turns_scored`, `turns_flagged`), `scorecard_flags` (`seq`, `label`, `quote`, `explanation`) and `scorecard_rewrites` (`seq`, `original`, `suggestion`). Founders have `SELECT` only; writes are service-role-only functions `claim_scorecard(session)` (row-locked, 60 s lease, only `ended` sessions; returns `not_found | not_ended | ready | insufficient | in_progress | claimed`; a `failed` card can be re-claimed) and `store_scorecard(...)` (stores only a claimed attempt, replaces flags and rewrites atomically, needs >= 1 rewrite for `ready`, and **copies every quote and original from the stored turn in SQL**; the model's text for them is ignored). Revoke `EXECUTE` explicitly, as for S-05.
- Pure modules `src/lib/services/scorecard.ts` (labels as problems found, `LABEL_META`, `BETA_DISCLAIMER`, `SCORE_FAILURE_COPY`, prompt, zod schema, `parseScore`) and `scorecard-run.ts` (attempt loop with injected model and clock: 12 s per attempt, 25 s shared deadline, a second attempt only with >= 6 s left); orchestration `scorecard-service.ts` (`scoreSession`, two clients as in S-05), RLS reads `scorecards.ts` (`getScorecard`). The model returns turn positions and prose only; any unknown position, viability wording in model prose, or hypothetical/repeated rewrite fails the whole attempt.
- Route: JSON `POST /api/rehearsal/sessions/[id]/score` (401 / 404 / 409 `not_ended` / 415; 200 with `{status: ready | insufficient | failed | in_progress, message?}`; a failed scoring is a saved state, not an HTTP error). Idempotent: a finished card is returned as it is, a fresh lease elsewhere answers `in_progress`, zero turns is `insufficient` with no AI call.
- **Scoring is page-triggered, not part of ending a session.** `/rehearsal/[id]/scorecard` renders the card on the server from RLS reads (disclaimer first, summary, a derived "N of M questions had nothing flagged" line, flagged questions grouped by `seq`, "Try asking it like this" rewrites). With no card, or after a failure, the island `src/components/rehearsal/ScorecardStatus.tsx` (hook `useScorecardRun.ts`) POSTs `/score` on arrival, polls every 3 s on `in_progress` (max 12), reloads on `ready`/`insufficient`, and shows Try again on `failed` (never auto-retried). Island props carry only the session id, `autoStart` and static failure copy. There is **no numeric score**.

### Resumable sessions (S-07)

- Additive migration `20261001100600_rehearsal_resume.sql`: `rehearsal_turns.client_key` (not null, unique per session) and `reply_started_at`; `rehearsal_sessions.last_activity_at`; `ended_reason` also allows `expired`. `rehearsal_add_turn(session, question, client_key)` **replaced** the S-05 two-argument function. All decisions use the DB clock under row locks: a repeated key returns the saved turn (checked before the status, so a replay still resolves after the session ended), idle expiry (24 h) is applied inside `rehearsal_add_turn` and by `rehearsal_expire_idle(project)`, `rehearsal_claim_reply(session, seq)` is one conditional UPDATE (30 s lease: `claimed | answered | in_flight | not_found`), `rehearsal_release_reply` hands the lease back after a failed generation, `rehearsal_store_reply` clears it and counts as activity. Only questions and stored replies move `last_activity_at`; reads, polls and claims never do. Same explicit `EXECUTE` revokes as for S-05.
- Pure module `src/lib/services/rehearsal-resume.ts` mirrors the boundaries (strictly past 30 s / 24 h): `isLeaseStale`, `isSessionExpired`, `classifyTurn` (`answered | in_flight | needs_reply`), `resolveReplay` (`answered | wait | resume`). In `rehearsal-service.ts`: `sendTurn` takes `clientKey` (no status check before the DB call), `retryReply` claims before generating (`pending: true` when it loses), `getSessionState` returns `ok | not_found | error` (never an empty list on a failed read), `expireIdleSessions` runs on start, on the list page and on every state read.
- Routes: `POST .../turns` requires `clientKey` (uuid) and may answer `pending: true`; `GET /api/rehearsal/sessions/[id]` returns `{status, endedReason, turns: [{seq, question, reply, clientKey}], pending: in_flight | needs_reply | null}` through `toPublicStateTurn` (no lease timestamps). The chat hook keeps one key per question text until it is saved, resyncs on foreground/online/pageshow, polls every 2 s only while a reply is in flight elsewhere, and resumes an abandoned reply once automatically before showing Try again.

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
