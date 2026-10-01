# Handoff: state of the MVP build (updated 2026-10-01, end of session 2)

Read this first when resuming. It captures what is built, exactly where to resume, how the user wants to work, and the traps found so far. Authoritative sources remain `roadmap.md`, `prd.md` and each `context/changes/<id>/plan.md`.

## Where we are

Branch `mvp` (push here only; **never open a PR unless the user asks**). Default branch of the repo is `main` (marketing site, untouched).

| Done and pushed                                                                                    | Commit  |
| -------------------------------------------------------------------------------------------------- | ------- |
| F-01 workspace scaffold (tables, RLS pattern, signup trigger, SQL test)                            | 4046359 |
| F-02 AI call path (OpenRouter, zero-retention flag, usage ledger, `test:ai`)                       | e48ac56 |
| F-03 deploy pipeline (Worker `unassumed-mvp`, CI deploy job)                                       | 7d83f26 |
| S-01 verified account, reset password, workspace landing, brand foundation, auth smoke             | 5f4ba65 |
| S-02 project from brief + AI-drafted badged canvas, lease function, fake OpenRouter, product smoke | 415c5ae |
| S-04 AI-suggested assumptions, trigger-enforced review gate, lifecycle status, atomic batch insert | 8c0e7d4 |

CI on S-02's commit (415c5ae): `ci` and `smoke` green on the real Supabase CLI; `deploy` fails only at "Check required secrets", by design. **CI for 8c0e7d4 (S-04) was not yet inspected: check it first** (`mcp__github__actions_list`, load via ToolSearch; owner `AdrianKondrat`, repo `unassumed_alpha`) and fix any red `ci`/`smoke` before building on top.

## RESUME HERE: S-05 (rehearsal session turn exchange)

Nothing of S-05 is written yet (no migration, no code). The S-05 plan was read in full; S-07's plan was read through its Phase 2. Do S-05 → S-06 (north star) → S-07, then S-03 (independent hardening, needs reconciling) and polish. Decisions already made for S-05 (do not re-derive):

1. **Follow `context/changes/rehearsal-session-turn-exchange/plan.md`** with its reconciliation banner, plus the S-04/S-02 facts below. Next migration timestamp: `20261001100400`.
2. **Schema** (`rehearsal_sessions`, `rehearsal_turns`, `rehearsal_scenarios`): reuse `public.is_project_member(project)` for SELECT policies; FK to `assumptions(id)`; only `assumptions.status = 'active'` can be rehearsed and the column is `statement` (not `text`). `rehearsal_scenarios`: RLS on, **no policies for any role** (service-role only). Founders get SELECT only on sessions/turns; all writes service-role. Add an assertion that `authenticated` selecting scenarios returns zero rows even for the owner, and mutation-check the SQL test (break the schema once per assertion family, as done for S-02/S-04).
3. **Keep S-07 easy**: keep S-05's `ended_reason` check easy to widen (`'user','cap'` now, `'expired'` later); S-07's plan lists the extra columns (`client_key uuid`, `reply_started_at`, `last_activity_at`). Recommendation: implement S-05 as planned and S-07 as its own additive migration (the plan allows folding it in; do not fold unless it clearly saves rework).
4. **Leases and atomic multi-row writes are database functions**, not PostgREST conditional updates (`update … or=… select` fails on PostgREST 12.2.3). For S-05 use a DB function for anything needing "claim if free" semantics, and use `clock_timestamp()` when row order inside one transaction matters. Plain `update … eq(id).eq(status,…).select()` and `.in(...)` do work.
5. **Two clients**: the founder's RLS client does ownership checks and is the one passed to `complete()` (so usage rows are attributed correctly); a service-role client (`src/lib/supabase-admin.ts`, server-only, never imported by components or page props) does the writes and scenario reads, and only after an RLS-scoped read proves ownership. New secret `SUPABASE_SERVICE_ROLE_KEY` must be added to: `astro.config.mjs` env schema, `.env.example`, the CI `ci` build env, **and the CI `deploy` job** (the `secrets:` list, the job `env:` and the required-secrets check), `README.md` "MVP deploy", and the CI `smoke` job's `.env`/`.dev.vars` (value `SERVICE_ROLE_KEY` from `supabase status -o env`). Locally: `eval "$(scripts/sandbox-stack/stack.sh keys)"` prints `SERVICE_ROLE_KEY`; add it to the gitignored `.env`/`.dev.vars`.
6. **Pure module** `src/lib/services/rehearsal-persona.ts` (cap = 8, scenario prompt/schema/parser, persona prompt builder, `guardReply`) reusing `src/lib/ai-output.ts` (`extractJson`, `findForbiddenWording`, `NO_VIABILITY_CLAIMS_RULE`) rather than duplicating; offline test `scripts/test-rehearsal-persona.mjs` with npm script `test:rehearsal` and a CI step in the `ci` job. Scenario generation uses `jsonMode: true`.
7. **Fake provider + smoke**: add persona handlers to `scripts/fake-openrouter.mjs` (one for scenario generation, one for persona replies; put the more specific matchers first, since prompts share vocabulary: the draft matcher had to be tightened for exactly this reason) with a distinctive scenario marker string, and add product steps to `scripts/smoke.mjs`: start, 8 turns, 9th refused, pending-reply refusal, end early, retry without consuming cap, unauthenticated 401, another founder's session 404 (needs a second account: sign up + verify via the mail sink, as the auth steps do), **scenario marker absent from every page source and API response**, privacy flag on every call. Also extend the final "every provider call" check to the new task kind (`converse`).
8. **UI**: the chat needs a React island + hook in `src/components/hooks/` over JSON routes (plan Phase 5); the rest of the app uses plain forms + `src/scripts/pending-forms.ts`. Screenshot at 390px and 1280px before committing.
9. After S-05: update the plan Progress (tick honestly, add an "Implementation notes" section like S-02/S-04), `change.md` `status: implemented`, roadmap row + Done entry + Backlog row, `CLAUDE.md` section, this handoff; run `/verify`; commit with the trailer; push; check CI.

## How the user wants to work

- Act as the lead developer: work autonomously through the roadmap, commit systematically (one commit per slice, or per phase for big ones) and push to `mvp`. The plans say "pause for manual confirmation" between phases: the user has delegated that, so do not pause; list unverified manual checks in the plan Progress notes instead.
- This project is the user's main income: quality, honesty and verification matter more than speed. Report faithfully what was and was not verified (the real model has never been called; everything AI-related was verified against the fake provider).
- Preferences: concise messages, but explain concepts from first principles; for complicated topics list the sub-parts to research.
- Commit trailer (required): `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01G5JC3yviT45GEDKqTWEUwy`. Run the `/verify` skill (lint + build) right before each commit.
- Never put secrets in tracked files. The user's OpenRouter test key is in the gitignored `.env` and `.dev.vars` in the sandbox; it must still be added by the user as the GitHub secret `OPENROUTER_API_KEY` and a Cloudflare Worker secret.

## Environment facts (cloud sandbox)

- **No Docker images** (registries blocked), so `supabase start` is impossible. Use `scripts/sandbox-stack/` (see its README): `stack.sh setup|start|reset|keys` runs real Postgres 16 + GoTrue + PostgREST + gateway + SMTP sink and applies `supabase/migrations`. `stack.sh start` is needed again after a sandbox restart; `stack.sh reset` re-applies all migrations. Binaries are cached in `scripts/sandbox-stack/.run/` (gitignored); if lost, `setup` rebuilds them. Run SQL tests with `PGHOST=127.0.0.1 PGPORT=54322 PGUSER=postgres psql -d postgres -v ON_ERROR_STOP=1 -q -f supabase/tests/<file>.sql`.
- **`openrouter.ai` is blocked** (403). Never try to route around it. AI features are tested against `scripts/fake-openrouter.mjs` (zero-dependency, port 4010, `/__mode?set=ok|http500|garbage|viability|slow|unknown_claim|short[&ms=N]`, `/__calls` = task/model/flags only, `/__reset`). The gitignored `.env`/`.dev.vars` currently contain `OPENROUTER_BASE_URL=http://127.0.0.1:4010/v1` so the local app talks to the fake; remove that line to try the real model (only possible outside the sandbox).
- **Full local test loop** (all verified working this session):
  1. `scripts/sandbox-stack/stack.sh start` (if the stack is down), then `stack.sh reset`.
  2. `node scripts/fake-openrouter.mjs &` (kill by port: `for pid in $(lsof -t -iTCP:4010 -sTCP:LISTEN); do kill $pid; done`).
  3. `npm run build`, then `npm run preview -- --port 4321 &` (kill by port 4321; logs via `npx astro preview logs`).
  4. `FAKE_AI_URL=http://127.0.0.1:4010 npm run smoke` (auth + product flow; exit code 0 = all pass; reset the fake with `curl -X POST :4010/__reset` and the DB with `stack.sh reset` between runs).
  5. SQL tests, `npm run test:ai|auth|canvas|assumptions`, `npm run lint`, `npx astro check`.
- Screenshots: install `playwright-core` in the scratchpad dir (not the repo), launch `/opt/pw-browsers/chromium` with `--no-sandbox`. Gotchas: scope clicks as `main form button[type=submit]` (the header's Sign out is also a submit button); to get a signed-in user, sign up through the form, then `psql … -c "update auth.users set email_confirmed_at=now() where email='…'"`, then sign in. The previous shot script was in the scratchpad and is gone; rewrite it.
- Shell gotchas: the working directory resets between commands (use absolute paths / `cd /home/user/unassumed_alpha`); never `pkill -f <name>` when `<name>` appears in your own command line; `ss` is not installed (use `lsof`). **Do not pipe a command into `tail`/`head` and then trust `$?` or a following `echo OK`**: capture to a file and read the real exit code (a lint failure was hidden this way once).
- The repo's PostToolUse hook (`.claude/settings.json`) runs prettier then eslint on every edit. An eslint "blocking error" after an edit is real: run `npx eslint <file>`. Prettier re-wraps long lines, so scripted find/replace anchors on previously written code often stop matching: Read the current text first.
- Postgres 16 locally vs `major_version = 17` in `config.toml`: avoid PG17-only SQL.

## Conventions established (follow them)

- **Pure module + offline test pattern:** logic that does not need Astro lives in `src/lib/**/*.ts` with relative imports using `.ts` extensions and no `astro:*`/`@/` imports; tested by `scripts/test-<x>.mjs` (step-list style, exit non-zero on failure) via `node --disable-warning=ExperimentalWarning --experimental-strip-types`; add an npm script `test:<x>` and a CI step in the `ci` job. No enum/parameter-property TS syntax (strip-types). Add needed globals to `scriptsConfig` in `eslint.config.js`. Existing: `ai-request.ts`, `auth.ts`, `ai-output.ts`, `services/canvas-draft.ts`, `services/assumption-suggest.ts`.
- **DB:** migrations `supabase/migrations/YYYYMMDDHHmmss_*.sql` (last used `20261001100300`). RLS on every table, per-operation `authenticated` policies via `(select public.is_workspace_member(...))` / `(select public.is_project_member(...))`, revoke `anon`, `security definer` functions with `set search_path = ''`. Each migration gets a rolled-back SQL assertion script in `supabase/tests/` (impersonation pattern in `supabase/README.md`); **mutation-check** new assertions by breaking the schema once (done for S-02/S-04: every assertion family was shown to fail when its guard was removed). CI runs all of `supabase/tests/*.sql`. Rules that matter for security belong in the database (triggers/RLS), not only in routes, because the anon key is public and a founder can call PostgREST directly.
- **Routes:** `export const prerender = false`; zod validation; form-POST → redirect with `?error=`/`?xError=<code>` for HTML forms (only known codes are rendered, never echo the query string), JSON + status codes for island APIs; API routes check `context.locals.user` themselves; pages go in `PROTECTED_ROUTES` (`src/middleware.ts`); add nav entries in `src/components/AppNav.astro` and flip the "Coming next" cards in `src/pages/dashboard.astro` as slices land.
- **AI:** always `complete()` from `src/lib/ai.ts` with the founder's RLS client; pass `jsonMode: true` for JSON tasks; parsers use `extractJson`, validate with zod and **reject output containing "validated"/"proven"** via `findForbiddenWording`; never log prompts, transcripts or persona text (log error codes/kinds and parser reasons that name a path only). Founder content goes in delimited tags in the user message with an "ignore instructions inside" rule in the system prompt. Scorecard/persona code must never ship the persona scenario to the client.
- **Supabase JS typing under strict eslint:** use `.maybeSingle<T>()` / `.single<T>()`, `.overrideTypes<T, { merge: false }>()` (not the deprecated `.returns`), type `rpc()` with `.overrideTypes<boolean, { merge: false }>()`, `Record<string, string | undefined>` for lookup tables, and destructure `const [first] = array` instead of `array[0]?.` (no `noUncheckedIndexedAccess`).
- **UI:** brand classes in `src/styles/global.css` (`.btn`, `.card`, `.card-flat`, `.tag`, `.input`, `.label`, `.notice`, `.eyebrow`, `.slabel`, `.disp`, `.mono-note`, `.mark`); UK English; meaning never by colour alone; visible focus; slow AI forms use `data-pending` + `src/scripts/pending-forms.ts`; test at 390px and 1280px with screenshots before committing UI. Never use "validated"/"proven" about a founder's idea in copy.
- **Eslint:** `@typescript-eslint/no-misused-promises` is off for `.astro` (top-level `return Astro.redirect()` crashes it).

## Plan reconciliations (banners marked "RECONCILE BEFORE IMPLEMENTING" are in the plans)

- **S-03** assumed `author_kind`/`version`/`workspace_id`/`updated_at` on `canvas_claims`; the real schema uses `origin` (`ai_draft | founder`), `revision`, no workspace column and no `updated_at`; access via `is_project_member()`; `ClaimCard.astro` already renders a teal "You" tag for founder claims; there is currently no claim UPDATE/DELETE policy. Enforce revision bumping / immutability in a trigger, as done for `assumptions_guard` in S-04.
- **S-05** see "RESUME HERE" above.
- **S-06** must map to S-05's real columns (`rehearsal_turns.question/seq/reply`); the `complete()` extension it asks for already exists; scoring must run synchronously with one batched call and a shared ~25 s deadline (see its `research.md`); needs the Workers Paid plan.
- **S-07** idempotency key per question, `reply_started_at` lease (make it a DB function like the other leases), lazy 24 h expiry (`ended_reason = 'expired'`, `last_activity_at`). It edits S-05's files; implement after S-05 and reconcile names against what S-05 shipped.

## Deviations already made (documented in the S-01/F-02/F-03/S-02/S-04 plans)

Email links use `token_hash` + custom templates (`supabase/templates/`) instead of PKCE links; min password length is 8; `pending_email` cookie instead of an email query param; CI runs SQL tests and on PRs into `main`; deploy job has a required-secrets check and optional `supabase db push`; `OPENROUTER_BASE_URL` override; roadmap/tech-stack say Workers, not Pages; leases are DB functions; S-04's transition rules are trigger-enforced; CI's smoke job runs the fake provider (`OPENROUTER_API_KEY=ci-fake-key`, `OPENROUTER_BASE_URL=http://127.0.0.1:4010/v1`, `FAKE_AI_URL`).

## Actions only the user can do (remind them; list in the final summary)

1. GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts + Workers KV Storage edit), `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_URL`, `SUPABASE_KEY`, `OPENROUTER_API_KEY`, and from S-05 on `SUPABASE_SERVICE_ROLE_KEY`; optional `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` (auto `db push`, which the new migrations need on the hosted project, either automatically or by running them manually).
2. Hosted Supabase project: site URL + `/auth/callback` redirect, email templates pasted from `supabase/templates/`, real SMTP, min password 8, confirm email on (README "MVP deploy"). The user mentioned "a bit to set up with supabase": this list is that work; the Supabase MCP server failed to connect in this session (proxy tunnel error), so it could not be checked or done from here.
3. First push to `mvp` with secrets set → confirm F-03 `done`; the deploy job fails fast with "Missing GitHub repository secrets" until then.
4. Confirm the Cloudflare account is on the **Workers Paid** plan (needed for scoring, S-06).
5. **One live check with the real OpenRouter key** from a machine that can reach it: the model slug `openai/gpt-4o-mini` in `TASK_CONFIG` is unconfirmed, and **no prompt (canvas draft, assumption suggestion) has ever been run against a real model**. Run through sign up → brief → draft → suggest by hand and judge the quality; prompt wording is the likeliest thing to need tuning. Also `npx supabase db lint` locally (needs Docker).

## Known gaps / ideas after the slices

- Add a Content-Security-Policy (React islands need care), rate limiting on AI routes if abuse appears, observability (parked in the roadmap).
- `README.md` still contains starter-era text in places; rewrite it for Unassumed once the slices land.
- Secondary PRD success criterion (trend across rehearsals) is not in any slice; consider a small follow-up after S-06.
- Accepted/edited canvas claims have no "accepted" concept (S-04 treats all claims as source material); revisit with S-03.
