# Hosted Supabase: setup runbook

Everything the MVP needs from a **hosted** Supabase project, in the order to do it. Until you do this, the repo's code is complete but nothing exists on your Supabase account: the migrations have never been applied there, the auth settings are defaults, and the emails are Supabase's stock templates.

> **Read first:** this runbook assumes the files added on 2026-10-02 exist: migration `20261002090000_explicit_api_grants.sql` (so 9 migrations in total) and `supabase/checks/hosted_verification.sql` (used in step 7). They are committed but have not been run in CI. See `context/foundation/handoff.md`, "Unfinished work from 2026-10-02". If you drop them, adjust steps 1, 3, 7 and 9 (8 migrations; verify the tables and RLS by hand).
>
> **Status (2026-10-02):** written from the code and the local/CI Supabase stack. **Not yet run against a real hosted project.** Dashboard labels move around between Supabase releases, so where a path below does not match, search the dashboard for the setting name in _italics_. Nothing in this runbook needs a code change; if a step fails, jump to [Troubleshooting](#9-troubleshooting).

**Time:** about 45 minutes the first time. **You need:** a Supabase account, the GitHub repo admin rights (secrets), a Cloudflare account, and an email-sending provider (step 4).

## What you are setting up (the 30-second picture)

| Piece           | Where it lives                            | What the code expects                                                                                                 |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Database schema | `supabase/migrations/*.sql` (9 files)     | 13 tables with row level security, 20 functions, one trigger on `auth.users` that gives each founder a workspace      |
| Auth behaviour  | Dashboard (not in the repo)               | Email + password, **email confirmation required**, password min length 8, our own email templates, a real SMTP sender |
| Three secrets   | GitHub secrets + Worker secrets           | `SUPABASE_URL`, `SUPABASE_KEY` (anon), `SUPABASE_SERVICE_ROLE_KEY` (server only)                                      |
| Readiness check | `supabase/checks/hosted_verification.sql` | Read-only script that must say `ALL PASS`                                                                             |

`supabase/config.toml` configures only the **local** CLI stack. It does not touch your hosted project (unless you run `supabase config push`, which this runbook does not use).

---

## 1. Create the project

1. Supabase dashboard → **New project**. Name it e.g. `unassumed-mvp`.
2. **Region:** pick the one closest to your founders and to Cloudflare's UK edge: _West EU (London)_ is the natural choice for a London company.
3. **Database password:** generate a strong one and **save it in your password manager now**. You need it for `supabase db push` (step 3) and it cannot be shown again (it can be reset).
4. **Plan:** the Free plan **pauses a project after a week of inactivity** and has no backups, which is unacceptable once real founders are using it. Use Pro for the beta (check current pricing). Free is fine only for a throwaway rehearsal of this runbook.
5. Wait until the project status is _Healthy_.

If the project creation screen has an option about **automatically exposing new tables/functions through the Data API**: either setting works with this repo. Migration `20261002090000_explicit_api_grants.sql` states every privilege explicitly, so the schema no longer depends on that default (a fix was started on 2026-10-02 and is not finished: see `context/foundation/handoff.md`).

## 2. Collect the values you will need

Write these down (a password manager note works):

| Value                                       | Where to find it                                                                           | Used as                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| **Project URL** `https://<ref>.supabase.co` | Project Settings → _API_ / _Data API_                                                      | `SUPABASE_URL`                             |
| **Project ref** (the `<ref>` part)          | Project Settings → _General_ → Reference ID, or the dashboard URL `…/project/<ref>`        | `SUPABASE_PROJECT_REF` (optional, step 3)  |
| **anon / publishable key**                  | Project Settings → _API Keys_                                                              | `SUPABASE_KEY`                             |
| **service_role / secret key**               | Same page. **Server-only. Never put it in the browser, a screenshot, a chat or a commit.** | `SUPABASE_SERVICE_ROLE_KEY`                |
| **Database password**                       | The one you saved in step 1                                                                | `SUPABASE_DB_PASSWORD` (optional, step 3)  |
| **Access token**                            | <https://supabase.com/dashboard/account/tokens> → Generate new token                       | `SUPABASE_ACCESS_TOKEN` (optional, step 3) |

**Which key format?** Supabase now offers two: the older JWT-style `anon` / `service_role` keys ("legacy") and newer `sb_publishable_…` / `sb_secret_…` keys. Everything in this repo (local, CI, the 122-step smoke test) was exercised with the **JWT-style keys**, so use those if the dashboard still lists them under _Legacy API Keys_. The newer keys should work with the installed `@supabase/supabase-js` but are untested here: if you choose them, run the whole of step 8 before telling anyone the app works.

## 3. Apply the database migrations

Pick **one** route. Route A is recommended: it also keeps every future migration in sync automatically.

### Route A: let CI do it (recommended)

Add these three GitHub repository secrets (Settings → Secrets and variables → Actions → New repository secret): `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`. On every push to `mvp` the deploy job then runs `supabase link` + `supabase db push` **before** deploying, so the code never runs ahead of the schema. The deploy job is the only thing that touches your hosted database. It only runs after lint, tests and the smoke test have passed.

### Route B: run it yourself once (also fine, and good for a first look)

From a checkout of the `mvp` branch, with Node 22 (`npm ci` first):

```sh
npx supabase login                                   # opens a browser, or paste the access token
npx supabase link --project-ref <ref>                # asks for the database password
npx supabase db push --dry-run                       # lists what WOULD be applied: expect 9 migrations
npx supabase db push                                 # applies them
npx supabase migration list                          # every row should show a Local and a Remote timestamp
```

### Route C: no CLI at all (last resort)

Dashboard → **SQL Editor** → run each file in `supabase/migrations/` **in filename order** (`20261001100000_…` first, `20261002090000_…` last), one at a time. Stop at the first error and read it. You then do not get the CLI's migration history, so later pushes with the CLI will try to re-apply everything: only use this route if you will keep applying migrations by hand.

**Expected result:** Table Editor shows 13 tables in the `public` schema, each marked _RLS enabled_.

## 4. Configure authentication (the part the repo cannot do for you)

All of this is in the dashboard. Do it **after** you know the app's URL (step 6 explains the order). The values to set:

| Setting (search for the name)                                    | Value                                                                                                         | Why                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| _Site URL_ (Authentication → URL Configuration)                  | The app origin, **no trailing slash**: `https://unassumed-mvp.<your-subdomain>.workers.dev`                   | The email templates build their links from it. Wrong value = every email link points to the wrong place                                          |
| _Redirect URLs_ (same page)                                      | `<app origin>/auth/callback` and `<app origin>/**`                                                            | Allow-list for post-auth redirects                                                                                                               |
| _Confirm email_ (Authentication → Sign In / Providers → Email)   | **On**                                                                                                        | Verification is mandatory (FR-001)                                                                                                               |
| _Minimum password length_ (Authentication → Sign In / Providers) | **8**                                                                                                         | The forms and server validation both require 8                                                                                                   |
| _Allow anonymous sign-ins_                                       | **Off**                                                                                                       | Not used                                                                                                                                         |
| _Email provider_                                                 | Enabled; disable every other provider                                                                         | Email + password only                                                                                                                            |
| _Enable refresh token rotation_ / _JWT expiry_                   | Defaults (on / 3600 s)                                                                                        | Matches the local config                                                                                                                         |
| _Email templates_ → **Confirm sign up**                          | Paste the whole file `supabase/templates/confirmation.html`; subject `Confirm your email address`             | Links to `/auth/callback?token_hash=…`, which works when the email is opened on another phone/browser                                            |
| _Email templates_ → **Reset password**                           | Paste the whole file `supabase/templates/recovery.html`; subject `Reset your password`                        | Same, for password recovery                                                                                                                      |
| _SMTP settings_ (Authentication → Emails → SMTP)                 | Your provider's host, port, user, password, a **sender address on a domain you own**, sender name `Unassumed` | Supabase's built-in mailer sends only a few emails an hour and only to your own team: real founders would never receive their verification email |
| _Rate limits_ (Authentication → Rate Limits)                     | After SMTP is set, raise _emails per hour_ to something sensible (e.g. 30–60)                                 | The default is tiny; a single launch day would exhaust it                                                                                        |

**Choosing an SMTP sender:** any transactional email service works (Resend, Postmark, Amazon SES, Brevo, …). Whichever you pick, verify your sending domain (SPF + DKIM records) or messages will land in spam. Your landing page already sends mail via Resend, so reusing the same Resend account with a verified domain is the least work. Use a different sender address or subdomain (e.g. `auth@…`) so the two streams do not share a reputation.

**Do not** change the `{{ .SiteURL }}` / `{{ .TokenHash }}` placeholders inside the templates.

## 5. Add the secrets (GitHub and Cloudflare)

GitHub → repo → Settings → Secrets and variables → Actions. The deploy job copies the first six onto the Cloudflare Worker for you (it fails fast and lists any that are missing):

| Secret                                                                  | Value                                                             |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `SUPABASE_URL`                                                          | Project URL (step 2)                                              |
| `SUPABASE_KEY`                                                          | anon / publishable key                                            |
| `SUPABASE_SERVICE_ROLE_KEY`                                             | service_role / secret key                                         |
| `OPENROUTER_API_KEY`                                                    | Your OpenRouter key                                               |
| `CLOUDFLARE_API_TOKEN`                                                  | Token with _Workers Scripts: Edit_ and _Workers KV Storage: Edit_ |
| `CLOUDFLARE_ACCOUNT_ID`                                                 | Cloudflare account id                                             |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` | Only for Route A (step 3)                                         |

The Workers **Paid** plan is needed for the scorecard (it can take up to ~25 s).

## 6. Order of operations on the very first deploy (there is one chicken-and-egg)

The Site URL (step 4) is the Worker's URL, which you only learn from the first deploy, and the first deploy needs the secrets. So:

1. Do steps 1, 2 and 3 (project, values, migrations).
2. Do step 5 (secrets).
3. Push to `mvp` (or re-run the failed workflow). The deploy job applies migrations (Route A), builds, deploys, and prints the URL (`https://unassumed-mvp.<subdomain>.workers.dev`) in its log. The homepage should answer 200.
4. **Now** do step 4 (Site URL, Redirect URLs, templates, SMTP) with that URL.
5. Run step 7 and step 8.

**Do not sign up in the app before step 4 is finished**: the confirmation email would carry the wrong link and the address would be "used up".

If you later add a custom domain, change the Site URL and the Redirect URLs to it (the old Worker URL keeps working only if you leave both allow-listed).

## 7. Verify the database (2 minutes)

Dashboard → **SQL Editor** → new query → paste the entire contents of `supabase/checks/hosted_verification.sql` → Run. It is read-only.

Expected: every row `PASS` and a last row `SUMMARY | ALL PASS`. If any row says `FAIL`, its `detail` column names the exact table/function, and the usual cause is a migration that did not apply (re-run step 3). **Do not continue to step 8 until it is `ALL PASS`.**

Then open Dashboard → **Database → Advisors → Security Advisor** and run it. Expect at most an informational "RLS enabled, no policy" note for `rehearsal_scenarios`: that is deliberate (the hidden persona must be unreadable to every client). Anything marked as a warning or error is worth reading before launch.

## 8. Verify the live app end to end (15 minutes, uses real email and the real AI model)

Use a real inbox you control, and open the email link on a **different device** than the one you signed up on (this is the case the templates exist for).

1. `https://<app>/` loads. Create an account. You land on a "Check your email" page.
2. The verification email arrives (check spam on the first attempt) from your SMTP sender, styled like the template. Open its button on another device: you land on the dashboard, signed in, showing **Personal workspace**.
3. In the dashboard: **Table Editor** → `workspaces` and `workspace_members` each gained exactly one row for you, and `auth.users` shows the address as confirmed.
4. Create a project with a rough brief, draft the canvas, edit a claim, ask for assumptions, accept two, start a rehearsal on one, send 3 questions and end it, open the scorecard. This is also the **first run against the real AI model** (nothing has ever been checked against it): read the persona and the scorecard critically, and look for "validated"/"proven" wording (there must be none).
5. Table Editor → `ai_usage_events` has one row per AI call, with token counts.
6. Sign out, use _Forgot password_, open the reset email, set a new password, sign in with it.
7. In a private window, confirm `<app>/dashboard` redirects to sign-in.
8. Optional but valuable: sign up a **second** account and confirm it sees none of the first account's data.

## 9. Troubleshooting

| Symptom                                                   | Most likely cause and fix                                                                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Red "Setup needed: Supabase is not configured" banner     | `SUPABASE_URL`/`SUPABASE_KEY` are not set as **Worker** secrets. Re-run the deploy job (it sets them).                                                                                          |
| Email link goes to `localhost` or the wrong host          | _Site URL_ is wrong or the templates were not pasted. Fix step 4, then request a new email (old links keep the old host).                                                                       |
| "That link has expired or was already used" straight away | The template was not replaced (stock links are not handled the same way), or an email scanner opened the link first. Request a new one; check step 4.                                           |
| No email arrives                                          | SMTP not configured (built-in mailer), sending domain not verified, or the rate limit. Check Authentication → Logs and your SMTP provider's log.                                                |
| Dashboard says "We couldn't load your workspace"          | The `on_auth_user_created` trigger is missing (the _signup trigger_ check in step 7) or the account was created before migrations. Re-apply migrations; delete the test user and sign up again. |
| `permission denied for table …` in logs                   | Migration `20261002090000_explicit_api_grants.sql` was not applied. Re-run step 3, then step 7.                                                                                                 |
| Rehearsal won't start / persona errors                    | `SUPABASE_SERVICE_ROLE_KEY` missing or set to the anon key. It must be the service_role / secret key.                                                                                           |
| "schema cache" errors after applying migrations           | Run `notify pgrst, 'reload schema';` in the SQL Editor.                                                                                                                                         |
| Everything fails after a quiet week                       | The project is on the Free plan and was paused. Restore it in the dashboard (and move to Pro).                                                                                                  |
| Deploy job fails at "Check required secrets"              | The log lists exactly which GitHub secrets are missing.                                                                                                                                         |
| Deploy job fails at "Apply database migrations"           | Wrong `SUPABASE_PROJECT_REF`/`SUPABASE_DB_PASSWORD`/token, or a migration error; the log shows the SQL error. Fix, push again.                                                                  |

## 10. Things to decide or know before inviting real founders

- **Anyone who finds the URL can sign up** (email confirmation is the only gate) and each account can spend AI credit up to the daily cap (300 model calls per founder per 24 h, in `src/lib/ai-request.ts`). For a private beta keep the URL private and watch `ai_usage_events`. You can set a spending limit in OpenRouter. If you later want invite-only, note that turning off _Allow new users to sign up_ and inviting by email needs a small code change first: the callback currently accepts only the `email`, `signup` and `recovery` link types, not `invite`.
- **No CAPTCHA and no per-IP rate limit** on the auth forms yet (Supabase's own rate limits apply). Reasonable for a small beta; revisit before public launch.
- **Backups:** only on paid plans; confirm they are on before real data arrives. Point-in-time recovery is a separate add-on.
- **Keys:** if the service_role key is ever exposed, rotate it in the dashboard and update the GitHub secret, then re-run the deploy job.
- **Region and data:** the project stores founders' notes and transcripts. Choose the region deliberately and keep your privacy notice consistent with it.

## Reference: what the migrations created

13 tables, all with RLS: `workspaces`, `workspace_members`, `ai_usage_events`, `projects`, `canvas_claims`, `assumptions`, `assumption_claims`, `rehearsal_sessions`, `rehearsal_turns`, `rehearsal_scenarios` (unreadable by clients), `scorecards`, `scorecard_flags`, `scorecard_rewrites`. Founders can write only their own project/canvas/assumption data; every rehearsal and scorecard write goes through server-only functions called with the service-role key. The trigger `on_auth_user_created` creates each founder's workspace atomically at signup. Details: `supabase/README.md` and `CLAUDE.md`.
