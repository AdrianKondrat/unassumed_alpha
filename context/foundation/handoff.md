# Handoff: state of the MVP build (updated 2026-10-01, session 3, all roadmap slices done)

Read this first when resuming. It captures what is built, exactly where to resume, how the user wants to work, and the traps found so far. Authoritative sources remain `roadmap.md`, `prd.md` and each `context/changes/<id>/plan.md`.

## Where we are

Branch `mvp` (push here only; **never open a PR unless the user asks**). Default branch of the repo is `main` (marketing site, untouched).

| Done and pushed                                                                                                                    | Commit                 |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| F-01 workspace scaffold (tables, RLS pattern, signup trigger, SQL test)                                                            | 4046359                |
| F-02 AI call path (OpenRouter, zero-retention flag, usage ledger, `test:ai`)                                                       | e48ac56                |
| F-03 deploy pipeline (Worker `unassumed-mvp`, CI deploy job)                                                                       | 7d83f26                |
| S-01 verified account, reset password, workspace landing, brand foundation, auth smoke                                             | 5f4ba65                |
| S-02 project from brief + AI-drafted badged canvas, lease function, fake OpenRouter, product smoke                                 | 415c5ae                |
| S-04 AI-suggested assumptions, trigger-enforced review gate, lifecycle status, atomic batch insert                                 | 8c0e7d4                |
| S-05 hidden-persona rehearsal: start, up to 8 questions, retry, end early / auto-end at the cap; scenario unreadable by any client | 06b4de6                |
| S-06 part 1: scorecard schema, scoring module, deadline-bound service, `/score` route                                              | 13066c3                |
| S-06 part 2: scorecard page + scoring island, entry links, fake-provider handler, 9 smoke steps (102 total), docs                  | 39642ca                |
| S-07 resumable sessions: idempotency key, reply lease, lazy 24 h expiry, state route, resilient chat hook, 112 smoke steps         | see `git log` ("S-07") |

CI status (checked in session 3): S-02, S-04, S-05 (06b4de6 + the CLI-pin commit f46b265): `ci` and `smoke` green **on the real Supabase CLI** (including S-05's real-PostgREST privacy step); `deploy` fails only at "Check required secrets", by design. The `smoke` job once failed with `supabase/setup-cli: rate limit exceeded` (GitHub API, unrelated to code); the CLI version is now pinned (2.117.0). Check the CI run of the latest commit first. Tip: `mcp__github__actions_list` `list_workflow_runs` ignores `per_page` and returns a huge payload; prefer `list_workflow_jobs` with a known run id (run URL in the push result / the previous listing) and `get_job_logs` with `return_content: true`.

## RESUME HERE: polish, then the user-only live checks

Every roadmap slice (F-01..F-03, S-01..S-07) is implemented on `mvp`. What is left is polish and things only the user can do:

1. **README rewrite** for Unassumed (it still has starter-era text), a **Content-Security-Policy** (React islands need care), **rate limiting** on the AI routes if abuse appears, observability (parked in the roadmap).
2. The secondary PRD success criterion (trend across rehearsals) is not in any slice; consider a small follow-up.
3. The **user-only actions** below (GitHub secrets, hosted Supabase, Workers Paid plan, one hands-on pass with the real OpenRouter key). Nothing in this repo has ever been run against the real model: prompts for canvas draft, assumption suggestion, persona and scoring, the `openai/gpt-4o-mini` slug and latency are all unverified.

### What S-03 shipped

- DB (`20261001100700_canvas_claims_editing.sql`, test `supabase/tests/canvas_claims_editing.sql`): UPDATE/DELETE policies, the `canvas_claims_guard` trigger (revision bump, origin on text change, immutable placement), `add_canvas_claim` (advisory lock, next position, cap 12). There is no `updated_at`.
- Code: `canvas-edit.ts` (pure, `npm run test:canvas-edit`), `claims.ts`, `claims-route.ts`, routes `POST /api/claims` and `PATCH|DELETE /api/claims/[id]`, island `CanvasEditor` + `useClaimEditor` on `/project`; `CanvasBoard.astro` and `ClaimCard.astro` were removed. `/project?blank=1` starts an empty canvas.
- Tests: 120 smoke steps; 19 SQL mutations (16 caught, 3 equivalent), 10 offline, 9 app-level; a Chromium script for the two-tab conflict, keyboard-only use, deleted-elsewhere and the blank canvas.
- Not verified: `npx supabase db lint` (needs Docker).

### What S-07 shipped (for S-03 and later)

- DB (`20261001100600_rehearsal_resume.sql`, tests `supabase/tests/rehearsal_resume.sql` plus the updated S-05/S-06 scripts): `client_key`, `reply_started_at`, `last_activity_at`, `expired` end reason; `rehearsal_add_turn` now takes a key (the two-argument version is gone); new service-only `rehearsal_claim_reply`, `rehearsal_release_reply`, `rehearsal_expire_idle`.
- Code: `src/lib/services/rehearsal-resume.ts` (pure, `npm run test:rehearsal-resume`), `rehearsal-service.ts` (`sendTurn` with `clientKey`, claim-first `retryReply`, `getSessionState`, `expireIdleSessions`), `GET /api/rehearsal/sessions/[id]`, the resilient hook `useRehearsalSession.ts` and `RehearsalChat.tsx` (waiting state, "Reconnected" note, expired copy).
- Tests: 112 smoke steps. The S-07 lease/expiry steps use `DATABASE_URL` (psql) to age a lease or a session; CI sets it, locally pass `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` or those steps are skipped. 18 SQL mutations (17 caught, 1 equivalent), 8 app mutations and 6 hook mutations (Chromium) were each caught.
- **Not verified**: the real model and Cloudflare Workers behaviour when a client abandons a request (the design tolerates it: the lease just goes stale after 30 s and the reply resumes), and `npx supabase db lint` (needs Docker).

### What S-06 shipped (for S-07 and later)

- DB (`20261001100500_scorecards.sql`, test `supabase/tests/scorecards.sql`): `scorecards`, `scorecard_flags`, `scorecard_rewrites` (founders SELECT only), service-only `claim_scorecard` and `store_scorecard` (quotes copied from the stored turn in SQL).
- Code: `src/lib/services/scorecard.ts` (labels, `BETA_DISCLAIMER`, `SCORE_FAILURE_COPY`, prompt, `parseScore`), `scorecard-run.ts` (12 s per attempt, 25 s shared deadline), `scorecard-service.ts` (`scoreSession`), `scorecards.ts` (`getScorecard`), route `POST /api/rehearsal/sessions/[id]/score`, page `src/pages/rehearsal/[id]/scorecard.astro`, island `src/components/rehearsal/ScorecardStatus.tsx` + hook `src/components/hooks/useScorecardRun.ts`. Scoring is page-triggered (the island POSTs on arrival), never inside the end-session request; no numeric score.
- Tests: `npm run test:scorecard` (24 checks), fake provider `score` handler, smoke steps (102 total). Nine app-level mutations were each caught; the island was checked in Chromium (auto-start once, no auto-retry after failure, Try again, polling on `in_progress`, 390/1280 px).
- **Not verified (needs the real model, plan Phase 5)**: whether the real model flags sensibly, p95 latency against the 25 s deadline, and the `openai/gpt-4o-mini` slug. Scoring needs the Workers Paid plan.

### What S-05 shipped (for S-06 / S-07)

- Service surface in `rehearsal-service.ts`: `startSession`, `sendTurn`, `retryReply`, `endSession` (each takes `{ supabase /* founder RLS */, admin /* service role */, founderId, ... }`). DB functions (service-role only): `start_rehearsal_session`, `rehearsal_add_turn`, `rehearsal_store_reply`, `rehearsal_end_session`. S-07 should extend these (idempotency key on the question, `reply_started_at` lease, `last_activity_at`, `'expired'` reason, which S-06's `claim_scorecard` already handles since it only requires `status = 'ended'`) as an additive migration; `ended_reason`'s check is meant to be widened.
- Routes: form `POST /api/rehearsal/sessions`; JSON `POST /api/rehearsal/sessions/[id]/turns|retry|end|score`; helpers in `rehearsal-route.ts` (`prepare`, `json`, `readJsonBody`, `turnResponse`) and `rehearsal-http.ts` (`statusForCode`, `toPublicTurn`, `isJsonContentType`); reads in `rehearsals.ts` and `scorecards.ts`; chat island `src/components/rehearsal/RehearsalChat.tsx` + hook `src/components/hooks/useRehearsalSession.ts`.
- Persona: scenario generated at start (`converse`, `jsonMode`, 20 s timeout), stored in `rehearsal_scenarios` (client-unreadable), injected only into the system prompt of each reply call. `guardReply` rejects viability wording, endorsement wording and setup leaks.
- Fake provider: handlers `scenario` and `persona` (marker `SCENARIO-MARKER-9c1e`; extra call flags `historyPairs`, `scenarioInSystem`, `scenarioInChat`; modes `viability` and `leak` also apply to them).
- Local sandbox state at the time of writing: stack, fake provider (:4010) and preview (:4321) were running and the DB was reset; the gitignored `.env`/`.dev.vars` hold the sandbox keys including `SUPABASE_SERVICE_ROLE_KEY`. If the sandbox restarted: `scripts/sandbox-stack/stack.sh start`, `node scripts/fake-openrouter.mjs &`, rebuild, preview.

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
  4. `eval "$(scripts/sandbox-stack/stack.sh keys)"; FAKE_AI_URL=http://127.0.0.1:4010 SUPABASE_URL=$API_URL SUPABASE_ANON_KEY=$ANON_KEY npm run smoke` (auth + product flow incl. the real-PostgREST privacy check; 120 steps; add `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` to run the S-07 lease/expiry steps; exit code 0 = all pass; reset the fake with `curl -X POST :4010/__reset` and the DB with `stack.sh reset` between runs).
  5. SQL tests, `npm run test:ai|auth|canvas|assumptions|rehearsal`, `npm run lint`, `npx astro check`.
- Screenshots: install `playwright-core` in the scratchpad dir (not the repo), launch `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` with `--no-sandbox` (set up the founder over HTTP like the smoke test and inject the cookies into the browser context; Playwright's `text=Try again` matches the first element containing the text, so target buttons with `button:has-text(...)`). Gotchas: scope clicks as `main form button[type=submit]` (the header's Sign out is also a submit button); to get a signed-in user, sign up through the form, then `psql … -c "update auth.users set email_confirmed_at=now() where email='…'"`, then sign in. The previous shot script was in the scratchpad and is gone; rewrite it.
- Shell gotchas: **never write `echo "... $(cmd) $?"`**: the command substitution resets `$?` to 0 and hides a failing psql (a SQL loop reported success this way in session 3; use `/tmp`-style helper that captures `rc=$?` first); the working directory resets between commands (use absolute paths / `cd /home/user/unassumed_alpha`); never `pkill -f <name>` when `<name>` appears in your own command line; `ss` is not installed (use `lsof`). **Do not pipe a command into `tail`/`head` and then trust `$?` or a following `echo OK`**: capture to a file and read the real exit code (a lint failure was hidden this way once).
- The repo's PostToolUse hook (`.claude/settings.json`) runs prettier then eslint on every edit. An eslint "blocking error" after an edit is real: run `npx eslint <file>`. Prettier re-wraps long lines, so scripted find/replace anchors on previously written code often stop matching: Read the current text first.
- Postgres 16 locally vs `major_version = 17` in `config.toml`: avoid PG17-only SQL.

## Conventions established (follow them)

- **Pure module + offline test pattern:** logic that does not need Astro lives in `src/lib/**/*.ts` with relative imports using `.ts` extensions and no `astro:*`/`@/` imports; tested by `scripts/test-<x>.mjs` (step-list style, exit non-zero on failure) via `node --disable-warning=ExperimentalWarning --experimental-strip-types`; add an npm script `test:<x>` and a CI step in the `ci` job. No enum/parameter-property TS syntax (strip-types). Add needed globals to `scriptsConfig` in `eslint.config.js`. Existing: `ai-request.ts`, `auth.ts`, `ai-output.ts`, `services/canvas-draft.ts`, `services/assumption-suggest.ts`, `services/rehearsal-persona.ts`, `services/scorecard.ts` + `scorecard-run.ts`, `services/rehearsal-resume.ts`, `services/canvas-edit.ts`.
- **DB:** migrations `supabase/migrations/YYYYMMDDHHmmss_*.sql` (last used `20261001100500`). RLS on every table, per-operation `authenticated` policies via `(select public.is_workspace_member(...))` / `(select public.is_project_member(...))`, revoke `anon`, `security definer` functions with `set search_path = ''`. Each migration gets a rolled-back SQL assertion script in `supabase/tests/` (impersonation pattern in `supabase/README.md`); **mutation-check** new assertions by breaking the schema once (done for S-02/S-04: every assertion family was shown to fail when its guard was removed). CI runs all of `supabase/tests/*.sql`. Rules that matter for security belong in the database (triggers/RLS), not only in routes, because the anon key is public and a founder can call PostgREST directly.
- **Routes:** `export const prerender = false`; zod validation; form-POST → redirect with `?error=`/`?xError=<code>` for HTML forms (only known codes are rendered, never echo the query string), JSON + status codes for island APIs; API routes check `context.locals.user` themselves; pages go in `PROTECTED_ROUTES` (`src/middleware.ts`); add nav entries in `src/components/AppNav.astro` and flip the "Coming next" cards in `src/pages/dashboard.astro` as slices land.
- **AI:** always `complete()` from `src/lib/ai.ts` with the founder's RLS client; pass `jsonMode: true` for JSON tasks; parsers use `extractJson`, validate with zod and **reject output containing "validated"/"proven"** via `findForbiddenWording`; never log prompts, transcripts or persona text (log error codes/kinds and parser reasons that name a path only). Founder content goes in delimited tags in the user message with an "ignore instructions inside" rule in the system prompt. Scorecard/persona code must never ship the persona scenario to the client.
- **Supabase JS typing under strict eslint:** use `.maybeSingle<T>()` / `.single<T>()`, `.overrideTypes<T, { merge: false }>()` (not the deprecated `.returns`), type `rpc()` with `.overrideTypes<boolean, { merge: false }>()`, `Record<string, string | undefined>` for lookup tables, and destructure `const [first] = array` instead of `array[0]?.` (no `noUncheckedIndexedAccess`).
- **UI:** brand classes in `src/styles/global.css` (`.btn`, `.card`, `.card-flat`, `.tag`, `.input`, `.label`, `.notice`, `.eyebrow`, `.slabel`, `.disp`, `.mono-note`, `.mark`); UK English; meaning never by colour alone; visible focus; slow AI forms use `data-pending` + `src/scripts/pending-forms.ts`; test at 390px and 1280px with screenshots before committing UI. Never use "validated"/"proven" about a founder's idea in copy.
- **Eslint:** `@typescript-eslint/no-misused-promises` is off for `.astro` (top-level `return Astro.redirect()` crashes it). **ESLint is not enough: run `npx astro check` too** (it caught `rpc().overrideTypes` mistyping that ESLint passed). After adding an `astro:env` variable run `npx astro sync` or ESLint reports `error typed` values.
- **Service-only DB functions**: `revoke all ... from public, anon, authenticated` then `grant execute ... to service_role`, because Supabase's default privileges grant new functions to every role; a `security invoker` function would also fail on table privileges, which hides a wrongly granted `EXECUTE`, so assert grants with `has_function_privilege`. Validate RPC results with zod.
- **Mutation-check everything that guards something**: break the guard, watch the test fail, restore (done for S-05's SQL, offline test and four smoke-level behaviours; the scripts used were throwaway). A test that passed first time proved nothing yet.

## Plan reconciliations (banners marked "RECONCILE BEFORE IMPLEMENTING" are in the plans)

- **S-03** implemented; see "What S-03 shipped" above.
- **S-05** implemented; see "What S-05 shipped" above.
- **S-06** implemented; see "What S-06 shipped" above.
- **S-07** implemented; see "What S-07 shipped" above.

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
- Canvas claims have no "accepted" concept (S-04 treats all claims as source material, edited or not); revisit if the AI-draft/founder distinction should affect suggestions.
