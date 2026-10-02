# Handoff: state of the MVP build (updated 2026-10-02 afternoon: hosted migrations applied + verified; launch work remains)

Read this first when resuming. It captures what is built, exactly where to resume, how the user wants to work, and the traps found so far. Authoritative sources remain `roadmap.md`, `prd.md` and each `context/changes/<id>/plan.md`. Full runbook: `supabase/HOSTED_SETUP.md`.

## Current status (READ THIS FIRST) — 2026-10-02 afternoon

**Code:** all roadmap slices F-01..F-03 and S-01..S-07 are implemented on `mvp`.

**Hosted Supabase project `Unassumed_alpha`** (`gxhxhxioshyenbmwkrqg`, eu-west-1): **schema is live and verified.** Agents can query/migrate this project via the authenticated Supabase MCP (and the linked CLI).

| Done on hosted | Detail |
| --- | --- |
| All **9** migrations applied | Local ↔ remote timestamps match (`npx supabase migration list`). Includes `20261002090000_explicit_api_grants.sql`. |
| **13** public tables, RLS on | Confirmed via MCP `list_tables`. |
| `hosted_verification.sql` | **SUMMARY \| ALL PASS** (run with `npx supabase db query -f supabase/checks/hosted_verification.sql --linked`). |
| Auth basics for local Astro | Site URL `http://127.0.0.1:4321`; redirect allow-list for `127.0.0.1` / `localhost` `:4321` callback + `/**`; min password **8**; email confirmation **required** (`mailer_autoconfirm: false`). |
| Local env keys | Gitignored `.env` / `.dev.vars` hold `SUPABASE_URL`, `SUPABASE_KEY` / `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` (alias), `SUPABASE_JWKS_URL`, `OPENROUTER_API_KEY`. Also `@supabase/server` + skill `supabase-server` installed for agents. |

**Not done yet:** Worker deploy, GitHub/Cloudflare secrets, custom SMTP + custom email templates, live end-to-end with the real model, and a few agent-only follow-ups. See the two tables below.

### Still to finish — who does what

#### Founder must do (accounts, money, judgement — agents cannot finish these alone)

| # | What | How / where | Notes |
| --- | --- | --- | --- |
| 1 | **Custom SMTP** for Auth emails | Supabase Dashboard → Authentication → Emails → SMTP (Resend / Postmark / SES / …). Verify domain (SPF + DKIM). | Free tier + default mailer **blocks** custom templates until SMTP is set (API returned that error when we tried). Built-in mailer is rate-limited and only reliable for team addresses. |
| 2 | **Paste email templates** | Same Emails UI → Confirm sign up + Reset password. Paste whole files `supabase/templates/confirmation.html` and `recovery.html`; subjects already match the runbook. | Do this **after** SMTP. Templates use `/auth/callback?token_hash=…` (cross-device). |
| 3 | **GitHub Actions secrets** | GitHub → repo → Settings → Secrets and variables → Actions. | Required: `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Optional for auto `db push` on deploy: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` (= `gxhxhxioshyenbmwkrqg`), `SUPABASE_DB_PASSWORD`. Detail: `HOSTED_SETUP.md` step 5. |
| 4 | **Cloudflare Workers Paid** | Cloudflare account plan. | Needed for scorecard (sync work up to ~25 s). |
| 5 | **First deploy** | Push (or re-run workflow) on `mvp` once secrets exist. | Deploy job prints Worker URL. Until secrets exist it fails at "Check required secrets" by design. Marks F-03 `done` when a real deploy succeeds. |
| 6 | **Point Auth at the Worker URL** | After first deploy: Dashboard → Authentication → URL Configuration. Set Site URL to the Worker origin (no trailing slash); add `<origin>/auth/callback` and `<origin>/**` to redirect URLs (keep localhost entries if you still develop locally). | Chicken-and-egg: Site URL needs the Worker URL from step 5. **Do not sign up in the live app before this** or confirmation links point wrong. |
| 7 | **Live end-to-end with real model** | Sign up on another device, canvas → assumptions → rehearsal → scorecard → password reset. Judge quality; watch for "validated"/"proven". | `HOSTED_SETUP.md` step 8. First time anything hits real OpenRouter outside the fake provider. |
| 8 | **Pre-invite decisions** | Open vs invite-only signup, CAPTCHA, spend limits, backups/Pro plan, licence. | `HOSTED_SETUP.md` step 10 / roadmap `L-08`. Invite-only needs a small code change first (callback does not accept `invite` link type yet). |

#### Agent can do (no founder account step required, or founder only runs a finished script)

| # | What | How | Roadmap |
| --- | --- | --- | --- |
| A | Write `scripts/verify-scorecard-live.mjs` and prove it against the **fake** provider | S-06 plan Phase 5.1; add npm script + CI/offline check as appropriate. Founder later runs it with a real key in live pass. | `L-06` |
| B | Check CI for the grants / hosted-readiness commit | Confirm `smoke` → "Hosted-readiness checks" is green on the real Supabase CLI. Keep or fix; do not leave `L-09` hanging. | `L-09` |
| C | Tick stale Progress boxes in plans that CI already proved | e.g. `verified-account-and-workspace` 4.2, `ai-provider-integration` 4.2/4.3, `data-workspace-scaffold` 3.5. Leave real-model / Docker / operational boxes unchecked. | — |
| D | Further schema / SQL / RLS work on the hosted project | Prefer CLI `npx supabase … --linked` or MCP (`execute_sql` / iterate then `db pull` for migrations). Never invent migration filenames. Re-run `hosted_verification.sql` after grant/RLS changes. | — |
| E | Prompt / copy tuning after founder reports live quality issues | Edit prompts in `src/lib/services/*`; never log founder content or persona text. | after `L-05` |
| F | `npx supabase db lint` | Only if Docker is available on the machine. | `L-07` |

**Agent must not:** put secrets in tracked files; open a PR unless asked; change Site URL to production without the founder’s Worker URL; attempt to bypass OpenRouter blocks; apply destructive production data changes without asking.

### Hosted Supabase — earlier session notes (grants work, still relevant)

While writing `HOSTED_SETUP.md` an agent discovered the schema depended on Supabase **default table grants**. Fix (committed/pushed earlier the same day): migration `20261002090000_explicit_api_grants.sql`, `supabase/checks/hosted_verification.sql`, SQL test tweaks, CI "Hosted-readiness checks" step, `scripts/sandbox-stack/check-without-default-grants.sh`, doc edits. **That migration is now applied on the hosted project and verification passed.** Remaining for `L-09`: confirm the CI smoke step on the real CLI is green.

Security advisors on the hosted project (expected): INFO on `rehearsal_scenarios` (RLS on, no policies — deliberate); WARN on `is_*_member` SECURITY DEFINER helpers executable by `authenticated` (intentional for RLS).

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

## RESUME HERE

Every roadmap slice (F-01..F-03, S-01..S-07) and the planned polish (README rewrite, CSP, per-founder daily AI cap) is implemented on `mvp`. **Hosted DB migrations + verification are done** (see "Current status" above).

**Next critical path (founder):** SMTP → paste email templates → GitHub/Cloudflare secrets → Workers Paid → first deploy → flip Site URL to Worker → live E2E with real model. **Next agent work without waiting:** `L-06` (`scripts/verify-scorecard-live.mjs`), `L-09` (confirm CI hosted-readiness), stale plan Progress ticks.

Nothing in this repo has ever been run against the real model: prompts, `openai/gpt-4o-mini`, and scoring latency are unverified. Optional later: observability, per-IP auth rate limits, trend-across-rehearsals, licence, `npx supabase db lint` (Docker).

### What the polish pass shipped

- **CSP**: Astro's `security.csp` (hashes for its own scripts/styles, same-origin everything else, no `unsafe-inline`). One inline `style=` in `ScorecardStatus.tsx` was replaced by Tailwind classes. A Chromium script visited every page and island (auth, dashboard, canvas editing, assumptions, rehearsal chat, scorecard) listening for `securitypolicyviolation`: none; a deliberate cross-origin fetch, inline script and external image were all blocked, so the detector works. A smoke step asserts the header.
- **Daily AI cap** (`AI_DAILY_CALL_CAP = 300` in `src/lib/ai-request.ts`, counted from `ai_usage_events` over a rolling 24 h): `complete()` returns kind `daily_limit` before any provider call; draft, suggest, rehearsal start/turn/retry and scoring each show honest copy (`daily_limit` code, HTTP 429 on JSON routes). One smoke step fills the ledger to exactly the cap with psql and proves turn, retry, start and score refuse without a provider call, that rows older than 24 h and a ledger one below the cap do not block, and that clearing it restores everything; 8 mutations were caught (one by the offline test and then also by the smoke step after it was strengthened).
- **README** rewritten for Unassumed (what it is, how to run and test it, privacy-by-design, CI/deploy runbook, honest known limits).

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
- Env note (2026-10-02): gitignored `.env` / `.dev.vars` now hold **hosted** project keys (publishable + secret, plus `SUPABASE_SERVICE_ROLE_KEY` alias and `SUPABASE_JWKS_URL`). If you still use the local sandbox stack for smoke, regenerate sandbox keys with `scripts/sandbox-stack/stack.sh keys` into a separate env or swap back; do not commit either. For fake AI locally, set `OPENROUTER_BASE_URL=http://127.0.0.1:4010/v1`; remove it to hit the real model.

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
  4. `eval "$(scripts/sandbox-stack/stack.sh keys)"; FAKE_AI_URL=http://127.0.0.1:4010 SUPABASE_URL=$API_URL SUPABASE_ANON_KEY=$ANON_KEY npm run smoke` (auth + product flow incl. the real-PostgREST privacy check; 122 steps; add `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` to run the S-07 lease/expiry steps; exit code 0 = all pass; reset the fake with `curl -X POST :4010/__reset` and the DB with `stack.sh reset` between runs).
  5. SQL tests, `npm run test:ai|auth|canvas|assumptions|rehearsal`, `npm run lint`, `npx astro check`.
- Screenshots: install `playwright-core` in the scratchpad dir (not the repo), launch `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` with `--no-sandbox` (set up the founder over HTTP like the smoke test and inject the cookies into the browser context; Playwright's `text=Try again` matches the first element containing the text, so target buttons with `button:has-text(...)`). Gotchas: scope clicks as `main form button[type=submit]` (the header's Sign out is also a submit button); to get a signed-in user, sign up through the form, then `psql … -c "update auth.users set email_confirmed_at=now() where email='…'"`, then sign in. The previous shot script was in the scratchpad and is gone; rewrite it.
- Shell gotchas: **never write `echo "... $(cmd) $?"`**: the command substitution resets `$?` to 0 and hides a failing psql (a SQL loop reported success this way in session 3; use `/tmp`-style helper that captures `rc=$?` first); the working directory resets between commands (use absolute paths / `cd /home/user/unassumed_alpha`); never `pkill -f <name>` when `<name>` appears in your own command line; `ss` is not installed (use `lsof`). **Do not pipe a command into `tail`/`head` and then trust `$?` or a following `echo OK`**: capture to a file and read the real exit code (a lint failure was hidden this way once).
- The repo's PostToolUse hook (`.claude/settings.json`) runs prettier then eslint on every edit. An eslint "blocking error" after an edit is real: run `npx eslint <file>`. Prettier re-wraps long lines, so scripted find/replace anchors on previously written code often stop matching: Read the current text first.
- Postgres 16 locally vs `major_version = 17` in `config.toml`: avoid PG17-only SQL.

## Conventions established (follow them)

- **Pure module + offline test pattern:** logic that does not need Astro lives in `src/lib/**/*.ts` with relative imports using `.ts` extensions and no `astro:*`/`@/` imports; tested by `scripts/test-<x>.mjs` (step-list style, exit non-zero on failure) via `node --disable-warning=ExperimentalWarning --experimental-strip-types`; add an npm script `test:<x>` and a CI step in the `ci` job. No enum/parameter-property TS syntax (strip-types). Add needed globals to `scriptsConfig` in `eslint.config.js`. Existing: `ai-request.ts`, `auth.ts`, `ai-output.ts`, `services/canvas-draft.ts`, `services/assumption-suggest.ts`, `services/rehearsal-persona.ts`, `services/scorecard.ts` + `scorecard-run.ts`, `services/rehearsal-resume.ts`, `services/canvas-edit.ts`.
- **DB:** migrations `supabase/migrations/YYYYMMDDHHmmss_*.sql` (last used `20261001100700`). RLS on every table, per-operation `authenticated` policies via `(select public.is_workspace_member(...))` / `(select public.is_project_member(...))`, revoke `anon`, `security definer` functions with `set search_path = ''`. Each migration gets a rolled-back SQL assertion script in `supabase/tests/` (impersonation pattern in `supabase/README.md`); **mutation-check** new assertions by breaking the schema once (done for S-02/S-04: every assertion family was shown to fail when its guard was removed). CI runs all of `supabase/tests/*.sql`. Rules that matter for security belong in the database (triggers/RLS), not only in routes, because the anon key is public and a founder can call PostgREST directly.
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

## Actions only the user can do (canonical list: "Still to finish — Founder must do" above)

Short reminder — do not sign up on the hosted app until SMTP + templates + Site URL match the URL you will open:

1. SMTP + paste `supabase/templates/{confirmation,recovery}.html`.
2. GitHub secrets (and optional `SUPABASE_*` for auto `db push` — schema is already applied once; optional secrets keep future migrations in sync).
3. Workers Paid → first deploy on `mvp` → set Site URL / redirects to the Worker origin.
4. Live E2E with the real OpenRouter key; judge prompt/persona/scorecard quality.
5. Pre-invite decisions (`L-08`).

## Known gaps / ideas after the slices

- Observability and per-IP rate limiting on the auth routes (parked in the roadmap).
- Secondary PRD success criterion (trend across rehearsals) is not in any slice; consider a small follow-up after S-06.
- Canvas claims have no "accepted" concept (S-04 treats all claims as source material, edited or not); revisit if the AI-draft/founder distinction should affect suggestions.
