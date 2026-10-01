# Handoff: state of the MVP build (2026-10-01)

Read this first when resuming. It captures what is built, what is next, how the user wants to work, and the traps found so far. Authoritative sources remain `roadmap.md`, `prd.md` and each `context/changes/<id>/plan.md`.

## Where we are

Branch `mvp` (push here only; **never open a PR unless the user asks**). Default branch of the repo is `main` (marketing site, untouched).

| Done and pushed                                                                           | Commit  |
| ----------------------------------------------------------------------------------------- | ------- |
| F-01 workspace scaffold (tables, RLS pattern, signup trigger, SQL test)                   | 4046359 |
| F-02 AI call path (OpenRouter, zero-retention flag, usage ledger, `test:ai`)              | e48ac56 |
| F-03 deploy pipeline (Worker `unassumed-mvp`, CI deploy job)                              | 7d83f26 |
| S-01 verified account, reset password, workspace landing, brand foundation, 30-step smoke | 5f4ba65 |

**Next, in order:** S-02 → S-04 (S-03 can run in parallel/after) → S-05 → S-06 (north star) → S-07 (plan exists, written by the user/another session). Then polish (below). Every slice has `plan.md` with phases and a Progress checklist: follow it, tick boxes honestly, append notes for deviations, set `change.md` `status: implemented`, update `roadmap.md` (status + Done), and update `CLAUDE.md` for new conventions.

## How the user wants to work

- Act as the lead developer: work autonomously through the roadmap, commit systematically (one commit per slice, or per phase for big ones) and push to `mvp`. The plans say "pause for manual confirmation" between phases: the user has delegated that, so do not pause; list unverified manual checks in the plan Progress notes instead.
- This project is the user's main income: quality, honesty and verification matter more than speed. Report faithfully what was and was not verified.
- Preferences: concise messages, but explain concepts from first principles; for complicated topics list the sub-parts to research.
- Commit trailer (required): `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01G5JC3yviT45GEDKqTWEUwy`. Run the `/verify` skill (lint + build) right before each commit.
- Never put secrets in tracked files. The user's OpenRouter test key (few dollars of credit) is in the gitignored `.env` and `.dev.vars` in the sandbox; it must still be added by the user as the GitHub secret `OPENROUTER_API_KEY` and a Cloudflare Worker secret.

## Environment facts (cloud sandbox)

- **No Docker images** (registries blocked), so `supabase start` is impossible. Use `scripts/sandbox-stack/` (see its README): `stack.sh setup|start|reset|keys` runs real Postgres 16 + GoTrue + PostgREST + gateway + SMTP sink and applies `supabase/migrations`. `stack.sh start` is needed again after a sandbox restart. Binaries are cached in `scripts/sandbox-stack/.run/` (gitignored); if lost, `setup` rebuilds them (needs Go + github.com).
- **`openrouter.ai` is blocked** by the egress policy (403). Do not try to route around it. Test AI features with a local fake OpenRouter server and `OPENROUTER_BASE_URL=http://127.0.0.1:<port>/v1` (the base-URL override exists for this), plus the offline `test:*` scripts. The real model needs one manual check by the user.
- Run the app: `npm run build && npm run preview -- --port 4321` (workerd works). `.dev.vars`/`.env` need `SUPABASE_URL=http://127.0.0.1:54321`, `SUPABASE_KEY=<anon from stack.sh keys>`, `OPENROUTER_API_KEY`. Screenshots: `playwright-core` + `/opt/pw-browsers/chromium` with `--no-sandbox` (install playwright-core in a scratch dir, not the repo).
- Shell gotchas: the working directory resets between commands (use absolute paths / `cd /home/user/unassumed_alpha`); never use `pkill -f <name>` when `<name>` appears in your own command line (it kills the shell); `ss` is not installed (use `lsof`).
- The repo's PostToolUse hook (`.claude/settings.json`) runs prettier then eslint on every edit (it was fixed to be POSIX-sh compatible). An eslint "blocking error" after an edit is real: run `npx eslint <file>`.
- Postgres 16 locally vs `major_version = 17` in `config.toml`: avoid PG17-only SQL.

## Conventions established (follow them)

- **Pure module + offline test pattern:** logic that does not need Astro lives in `src/lib/**/*.ts` with relative imports using `.ts` extensions and no `astro:*`/`@/` imports; tested by `scripts/test-<x>.mjs` (step-list style, exit non-zero on failure) via `node --disable-warning=ExperimentalWarning --experimental-strip-types`; add an npm script `test:<x>` and a CI step in the `ci` job. No enum/parameter-property TS syntax (strip-types). Add needed globals to `scriptsConfig` in `eslint.config.js`.
- **DB:** migrations `supabase/migrations/YYYYMMDDHHmmss_*.sql` (last used `20261001100100`; next ones should sort after, e.g. `20261001100200`, `…100300`). RLS on every table, per-operation `authenticated` policies via `(select public.is_workspace_member(...))`, revoke `anon`, `security definer` functions with `set search_path = ''`. Each migration gets a rolled-back SQL assertion script in `supabase/tests/` (impersonation pattern in `supabase/README.md`); mutation-check new assertions by breaking the schema once. CI runs all of `supabase/tests/*.sql`.
- **Routes:** `export const prerender = false`; zod validation; form-POST → redirect with `?error=` for HTML forms, JSON + status codes for island APIs; API routes check `context.locals.user` themselves; pages go in `PROTECTED_ROUTES` (`src/middleware.ts`); add nav entries in `src/components/AppNav.astro` and flip the "Coming next" cards in `src/pages/dashboard.astro` as slices land.
- **AI:** always `complete()` from `src/lib/ai.ts` with the founder's RLS client; pass `jsonMode: true` for JSON tasks; parsers strip code fences, validate with zod and **reject output containing "validated"/"proven"**; never log prompts, transcripts or persona text. Scorecard/persona code must never ship the persona scenario to the client.
- **UI:** use the brand classes in `src/styles/global.css` (`.btn`, `.card`, `.tag`, `.input`, `.label`, `.notice`, `.eyebrow`, `.slabel`, `.disp`, `.mark`); UK English; meaning never by colour alone; visible focus; test at 390px and 1280px with screenshots before committing UI.
- **Eslint:** `@typescript-eslint/no-misused-promises` is off for `.astro` (top-level `return Astro.redirect()` crashes it). Strict type-checked rules apply elsewhere; untyped Supabase results need explicit generics (e.g. `.maybeSingle<Workspace>()`) or typed casts at the service boundary.

## Plan reconciliations already written into the plans (banners marked "RECONCILE BEFORE IMPLEMENTING")

- **S-03** assumed `author_kind`/`version`/`workspace_id`/`updated_at` on `canvas_claims`; S-02's real schema uses `origin`, `revision`, no workspace column. Adapt as the banner says.
- **S-05** must use `assumptions.statement` (not `text`) and needs the new `SUPABASE_SERVICE_ROLE_KEY` added to env schema, `.env.example`, CI build env **and the deploy job** (secrets list, env, required-secrets check, README).
- **S-06** must map to S-05's real columns (`rehearsal_turns.question/seq/reply`); the `complete()` extension it asks for already exists.
- **S-02/S-04:** use `jsonMode: true`; S-04 reuses S-02's `is_project_member()` and `projects` lease-column pattern (`draft_started_at` → `suggest_started_at`).
- **S-07** now has a plan (`resumable-rehearsal-sessions/plan.md`): client idempotency key per question, `reply_started_at` lease, lazy 24h expiry (`ended_reason = 'expired'`, `last_activity_at`). It edits S-05's files and widens S-05's `ended_reason` check, so implement it after S-05 and reconcile names in its Phases 1-3 against what S-05 actually shipped. S-05 should keep `ended_reason`'s check easy to widen.

## Deviations already made (documented in the S-01/F-02/F-03 plans)

Email links use `token_hash` + custom templates (`supabase/templates/`) instead of PKCE links; min password length is 8; `pending_email` cookie instead of an email query param; CI runs SQL tests and on PRs into `main`; deploy job has a required-secrets check and optional `supabase db push`; `OPENROUTER_BASE_URL` override; roadmap/tech-stack say Workers, not Pages.

## Actions only the user can do (remind them; list in the final summary)

1. GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts + Workers KV Storage edit), `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_URL`, `SUPABASE_KEY`, `OPENROUTER_API_KEY`, later `SUPABASE_SERVICE_ROLE_KEY`; optional `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` (auto `db push`).
2. Hosted Supabase project: site URL + `/auth/callback` redirect, email templates pasted from `supabase/templates/`, real SMTP, min password 8, confirm email on (README "MVP deploy").
3. First push to `mvp` with secrets set → confirm F-03 `done`; the deploy job currently fails fast with "Missing GitHub repository secrets" until then.
4. Confirm the Cloudflare account is on the **Workers Paid** plan (needed for scoring, S-06).
5. One live call with the real OpenRouter key from a machine that can reach it (model slug `openai/gpt-4o-mini` in `TASK_CONFIG` is unconfirmed), and `npx supabase db lint` locally (needs Docker).

## Known gaps / ideas after the slices

- Real GitHub Actions on `mvp` were inspected (run 36888199585, commit 5f4ba65): `ci` and `smoke` (real Supabase CLI, SQL assertions, 30-step smoke incl. emailed links) are green; only `deploy` fails, at "Check required secrets", by design until the user adds the secrets. Check the Actions result after every push (`mcp__github__actions_list`, load via ToolSearch) and fix red `ci`/`smoke` before moving on.
- Add a Content-Security-Policy (React islands need care), rate limiting on AI routes if abuse appears, observability (parked in the roadmap).
- `README.md` still contains starter-era text in places; rewrite it for Unassumed once the slices land.
- Secondary PRD success criterion (trend across rehearsals) is not in any slice; consider a small follow-up after S-06.
