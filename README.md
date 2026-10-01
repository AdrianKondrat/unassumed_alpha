# Unassumed

AI rehearsal for first-time founders. You write notes about your idea, get an AI-drafted Business Model Canvas to argue with, turn it into assumptions you could be wrong about, and then **interview a made-up customer** whose background you cannot see in advance. Afterwards you get a scorecard of **how you asked your questions**: leading, hypothetical, solution-biased, not about the past, too vague, with your exact words quoted and a better way to ask.

It scores the questions, never the idea. Nothing here says an idea is "validated" or "proven", and the practice customer is invented: what they say is not evidence about your market.

This repository is the MVP app (branch `mvp`). The landing page lives on `main`.

## What is built

| Slice | What a founder can do                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-01  | Sign up with a verified email, reset a password, land in a personal workspace                                                                     |
| S-02  | Write notes, get an AI-drafted nine-block canvas with every AI claim marked "AI draft"                                                            |
| S-03  | Edit, add and delete claims by hand; two edits racing from one saved revision give one winner and a side-by-side resolver, never a silent loss    |
| S-04  | Ask for AI-suggested riskiest assumptions, keep / reword / reject each, set a lifecycle status                                                    |
| S-05  | Rehearse an assumption against a hidden persona for up to 8 questions; retry a failed reply without losing the question                           |
| S-06  | Get a scorecard: flagged questions with exact quotes, rewrites, a beta disclaimer, no numeric score                                               |
| S-07  | Refresh, close the tab or lose the connection mid-session without losing or duplicating a turn; idle sessions expire after 24 h and stay readable |

Roadmap, PRD and per-slice plans are in `context/` (start with `context/foundation/handoff.md`). `CLAUDE.md` describes the architecture and conventions.

## Tech stack

- [Astro](https://astro.build/) 7 (server-rendered) with [React](https://react.dev/) 19 islands, [Tailwind CSS](https://tailwindcss.com/) 4
- [Supabase](https://supabase.com/) for auth and Postgres (row-level security on every table)
- [OpenRouter](https://openrouter.ai/) for all model calls
- [Cloudflare Workers](https://workers.cloudflare.com/) for hosting (scoring needs the Workers **Paid** plan)

## Quick start

Needs Node 22.14 (`.nvmrc`) and, for the database, Docker.

```bash
npm install
cp .env.example .env && cp .env.example .dev.vars   # then fill in the values below
npx supabase start                                   # applies supabase/migrations, starts auth + a mail catcher
npm run dev
```

`npx supabase start` prints the local API URL and keys. Email confirmation is required: sign-up emails land in the local mail catcher at <http://127.0.0.1:54324>.

### Environment variables

All are server-only (declared in `astro.config.mjs`); none reaches the browser.

| Variable                    | Purpose                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | Supabase project URL                                                                                          |
| `SUPABASE_KEY`              | The `anon` key                                                                                                |
| `SUPABASE_SERVICE_ROLE_KEY` | The `service_role` key. Used only on the server to read the hidden persona and call service-only DB functions |
| `OPENROUTER_API_KEY`        | OpenRouter key                                                                                                |
| `OPENROUTER_BASE_URL`       | Optional. Point the AI path at another OpenRouter-compatible endpoint (the local fake provider, a proxy)      |

Never commit these. `.env` and `.dev.vars` are gitignored.

### Running without a real model

`scripts/fake-openrouter.mjs` is a deterministic stand-in for OpenRouter, used by the tests:

```bash
node scripts/fake-openrouter.mjs &                       # listens on :4010
# in .env / .dev.vars:  OPENROUTER_BASE_URL=http://127.0.0.1:4010/v1
```

It has failure modes you can switch on (`/__mode?set=http500|garbage|viability|slow|...`). It proves the plumbing, **not** the quality of the real model's output.

## Scripts

| Command                                                                                                                                            | What it does                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `npm run dev` / `build` / `preview`                                                                                                                | Dev server (workerd), production build, preview of the build |
| `npm run lint` / `lint:fix` / `format`                                                                                                             | ESLint (type-checked) and Prettier                           |
| `npx astro check`                                                                                                                                  | Type checking for `.astro` and `.ts`                         |
| `npm run test:ai`, `test:auth`, `test:canvas`, `test:assumptions`, `test:rehearsal`, `test:scorecard`, `test:rehearsal-resume`, `test:canvas-edit` | Offline unit checks of the pure modules (no network)         |
| `npm run smoke`                                                                                                                                    | End-to-end smoke test against a running server (see below)   |

SQL assertions (RLS, constraints, triggers, service-only functions) run against a reset local database:

```bash
for f in supabase/tests/*.sql; do
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f "$f" || exit 1
done
```

### Smoke test

`scripts/smoke.mjs` is dependency-free and drives the real app over HTTP: auth (signup, emailed-link verification, password reset), then the whole product flow against the fake provider (canvas, assumptions, rehearsal, resume, scorecard, editing), including privacy checks through the real PostgREST with a founder's own token.

```bash
npm run build && npm run preview -- --port 4321 &
node scripts/fake-openrouter.mjs &
BASE_URL=http://localhost:4321 MAIL_URL=http://127.0.0.1:54324 FAKE_AI_URL=http://127.0.0.1:4010 \
SUPABASE_URL=<api url> SUPABASE_ANON_KEY=<anon key> \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run smoke
```

`FAKE_AI_URL` enables the AI-backed steps, `SUPABASE_URL` + `SUPABASE_ANON_KEY` the real-PostgREST privacy checks, and `DATABASE_URL` the steps that age a session or a reply lease with `psql`. Steps whose input is missing are skipped, not failed.

## Project structure

```
src/
  pages/            Astro pages and JSON/form API routes (pages/api)
  components/       Astro components and React islands (hooks in components/hooks)
  lib/              AI call path, Supabase clients, auth helpers
  lib/services/     Business logic: pure modules (testable offline) and the services that use them
  middleware.ts     Session resolution, route protection, security headers
supabase/
  migrations/       Schema, RLS, service-only functions
  tests/            SQL assertion scripts
  templates/        Email templates (confirmation, recovery)
scripts/            Smoke test, fake provider, offline tests, sandbox stack
context/            PRD, roadmap, per-slice plans and the handoff document
```

## Privacy and safety by design

- **Zero retention.** Every model request carries `provider.data_collection = "deny"`; founder content and persona text are never logged or returned to other clients.
- **The hidden persona cannot be read by any client.** Its table has RLS on, no policies and no client privileges; only server-side service-role code touches it, after an RLS read proved ownership.
- **Database-enforced rules.** Review gates, the turn cap, revision bumps, leases and idle expiry live in triggers and service-only functions, because the anon key is public and a founder can call PostgREST directly.
- **Content-Security-Policy** (Astro-generated, with hashes for its own inline scripts; no `unsafe-inline`, same-origin only), `X-Frame-Options: DENY`, `no-store` on founder content.
- **Cost backstop.** `complete()` refuses further calls once a founder has made 300 successful AI calls in a rolling 24 hours (counted from `ai_usage_events`); every flow explains this plainly.

## Deployment

Pushing to `mvp` runs CI and, once the secrets below exist, deploys the Cloudflare Worker `unassumed-mvp` (a different Worker from the landing page). Pushes to other branches never deploy.

### CI

`.github/workflows/ci.yml`:

- **ci**: lint, `astro check`, every offline test, build.
- **smoke**: local Supabase via the CLI (pinned version), SQL assertions, build, then the smoke test against the production preview with the fake provider and `DATABASE_URL`. No secrets needed.
- **deploy**: only on a push to `mvp`, after `ci` and `smoke`. Fails fast listing any missing secret.

### One-time setup

1. **Hosted Supabase project.** In the dashboard:
   - Authentication → URL Configuration: set _Site URL_ to the deployed Worker URL and add `<worker url>/auth/callback` to _Redirect URLs_.
   - Authentication → Providers → Email: keep _Confirm email_ **on** (verification is required) and set the minimum password length to 8.
   - Authentication → Emails → Templates: paste `supabase/templates/confirmation.html` into _Confirm sign up_ and `supabase/templates/recovery.html` into _Reset password_ (subjects "Confirm your email address" / "Reset your password"). They link to `/auth/callback?token_hash=…`, so verification works when the email is opened on another device.
   - Authentication → SMTP: configure a real provider (the built-in mailer is heavily rate-limited).
   - Apply the migrations in `supabase/migrations` (the deploy job can do it: see the optional secrets).
2. **GitHub repository secrets** (Settings → Secrets and variables → Actions):

   | Secret                                                                         | Purpose                                                                                                               |
   | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
   | `CLOUDFLARE_API_TOKEN`                                                         | Token with _Workers Scripts: Edit_ and _Workers KV Storage: Edit_ (the Astro adapter binds a `SESSION` KV namespace). |
   | `CLOUDFLARE_ACCOUNT_ID`                                                        | Your Cloudflare account id.                                                                                           |
   | `SUPABASE_URL`, `SUPABASE_KEY`                                                 | Hosted project URL and `anon` key (also set as Worker runtime secrets by the deploy job).                             |
   | `SUPABASE_SERVICE_ROLE_KEY`                                                    | Hosted `service_role` key. Server-only. Never expose it to the browser.                                               |
   | `OPENROUTER_API_KEY`                                                           | OpenRouter key for all AI calls (also set as a Worker runtime secret).                                                |
   | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` (opt.) | When all three exist, the deploy job runs `supabase db push` first so the schema never lags the code.                 |

3. Confirm the Cloudflare account is on the **Workers Paid** plan (see `context/changes/rehearsal-scorecard/research.md`: scoring runs synchronously for up to about 25 s).
4. Push to `mvp`.

A deploy runs lint, type check, offline checks, build and the smoke test, optionally `supabase db push`, then `wrangler deploy` and an HTTP 200 check. Deploys are serialised. Roll back with `npx wrangler rollback` or by re-deploying an earlier commit.

## Known limits (be honest with yourself before launch)

- **Nothing has been run against the real model.** Every AI path is verified against the fake provider. Prompt quality (canvas draft, assumption suggestion, persona realism, scoring flags), the `openai/gpt-4o-mini` model slug in `src/lib/ai-request.ts` and real latency against the 25 s scoring deadline all need one hands-on pass with a live key.
- Scoring quality is labelled **beta** in the product on purpose.
- `npx supabase db lint` (needs Docker) has not been run.
- Rate limiting beyond the per-founder daily AI cap, and observability, are not built.

## Licence

No licence file is included, so all rights are reserved by default. Choose a licence deliberately before making this repository public or accepting outside contributions.
