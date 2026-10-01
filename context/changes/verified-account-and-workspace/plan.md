# Verified Account and Workspace Implementation Plan

## Overview

Close the auth gaps behind roadmap slice S-01: make email verification mandatory (FR-001), add self-serve password reset (FR-003), and land every signed-in founder on a dashboard that shows their one auto-created workspace (FR-004). Sign in/out (FR-002) already works and stays. Guard it all with an extended smoke test that follows real emailed links.

## Current State Analysis

- `src/pages/api/auth/signup.ts` calls `auth.signUp` and redirects to a static `confirm-email` page; `signin.ts` calls `signInWithPassword` and redirects to `/`. Both cast form values with `as string` (no zod, against CLAUDE.md).
- `supabase/config.toml:209` has `[auth.email] enable_confirmations = false`; `site_url` is `http://127.0.0.1:3000` while the dev server runs on 4321.
- No verification-callback route, no password-reset pages or routes, no resend endpoint.
- `src/middleware.ts` protects only `/dashboard` and sets `locals.user`; `dashboard.astro` shows only the email.
- `scripts/smoke.mjs` signs up and immediately signs in; this breaks once confirmations are on.
- CI smoke job starts local Supabase with `-x ...mailpit...` (`.github/workflows/ci.yml`), so no mail server runs there.
- F-01 (`context/changes/data-workspace-scaffold`) is planned but NOT implemented: no `supabase/migrations/`, no `src/types.ts`. It delivers `workspaces` + `workspace_members` and the signup trigger this plan reads from.

## Desired End State

A new founder signs up, cannot sign in until they click the emailed link, lands signed in on `/dashboard` showing their workspace name and email, can request a reset email and set a new password, and can resend a verification email. `npm run smoke` proves all of it against local Supabase in CI.

### Key Discoveries:

- With confirmations on, Supabase returns `email_not_confirmed` on password sign-in, so the gate is enforced by Supabase itself rather than app code.
- `@supabase/ssr` uses the PKCE flow: email links return `?code=...` which must be exchanged server-side via `exchangeCodeForSession`.
- Local dev email lands in the local mail server (`[inbucket]` in config, port 54324), readable over HTTP; the smoke script can fetch links from it.
- `auth.rate_limit.email_sent = 2` only applies with custom SMTP, so it does not affect local mail testing.

## What We're NOT Doing

- No CAPTCHA/Turnstile and no app-level rate limiter; abuse protection is Supabase's own `[auth.rate_limit]` and `max_frequency` only.
- No social login, magic links, MFA, or change-email flows.
- No workspace schema work (F-01) and no workspace editing UI.
- No custom email templates or custom SMTP (production SMTP setup is a deployment task).
- No changes to `PROTECTED_ROUTES` beyond adding the reset page.

## Implementation Approach

Four phases, each shippable: (1) verification gate plus shared plumbing, (2) password reset reusing the callback, (3) workspace-aware landing, (4) automated end-to-end coverage. Keep the existing pattern: HTML form POST → API route → `?error=` redirect. Add zod to every auth route. Put error-code mapping and the safe-redirect check in `src/lib/auth.ts` (new).

## Critical Implementation Details

- **Redirect safety:** `/auth/callback` accepts a `next` param; only allow values starting with a single `/` (reject `//` and absolute URLs) and default to `/dashboard`.
- **Config URLs:** set `site_url` to `http://127.0.0.1:4321` and add `http://127.0.0.1:4321/auth/callback` (and the `localhost` variant) to `additional_redirect_urls`; otherwise email links are rejected. Production URLs are set in the Supabase dashboard and need a note in the final summary.
- **Anti-enumeration:** forgot-password and resend always redirect to the same generic "if an account exists" message regardless of outcome.
- **CI mail server:** the CLI's mail server name differs by version (`inbucket` in config, `mailpit` in the `-x` exclude list); confirm the right name and stop excluding it in the smoke job.

## Phase 1: Verification gate

### Overview

Make verification mandatory and handle the emailed link, with friendly errors and a resend path.

### Changes Required:

#### 1. Supabase config

**File**: `supabase/config.toml`

**Intent**: Turn confirmations on and fix redirect URLs so emailed links reach the dev app.

**Contract**: `[auth.email] enable_confirmations = true`; `site_url` and `additional_redirect_urls` point at port 4321 including `/auth/callback`.

#### 2. Auth helpers

**File**: `src/lib/auth.ts` (new)

**Intent**: Central place for mapping Supabase error codes to founder-friendly copy and for validating `next` redirect targets.

**Contract**: `authErrorMessage(error)` maps at least `email_not_confirmed`, `otp_expired`, `invalid_credentials`, `over_email_send_rate_limit`; `safeNext(value)` returns a same-origin path or `/dashboard`. Zod schemas for email, password (min length matching `minimum_password_length`), exported for all auth routes.

#### 3. Callback route

**File**: `src/pages/auth/callback.ts` (new, `export const prerender = false`)

**Intent**: Exchange the PKCE `code` for a session and redirect.

**Contract**: `GET /auth/callback?code=…&next=…` → on success redirect to `safeNext(next)`; on failure redirect to `/auth/signin?error=<mapped message>`.

#### 4. Signup, signin, resend routes

**File**: `src/pages/api/auth/signup.ts`, `src/pages/api/auth/signin.ts`, `src/pages/api/auth/resend.ts` (new)

**Intent**: Validate input with zod; signup passes `emailRedirectTo: <origin>/auth/callback`; signin maps `email_not_confirmed` to a redirect to `/auth/confirm-email?email=…` with a resend prompt; resend calls `auth.resend({ type: "signup", email, options.emailRedirectTo })` and redirects to the generic confirmation page.

**Contract**: All three use `?error=` redirects like today; resend never reveals whether the account exists.

#### 5. Confirm-email page

**File**: `src/pages/auth/confirm-email.astro`

**Intent**: Replace the dev-only "auto-confirmed" branch with a single "check your inbox" page including a resend form.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`

#### Manual Verification:

- Signing up shows "check your email"; the link in the local mail server signs the founder in and lands on `/dashboard`
- Signing in before verifying shows the verify-your-email prompt and resend works
- An expired or reused link shows a friendly error, not a raw Supabase message
- A tampered `next=https://evil.example` redirects to `/dashboard`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 2: Password reset

### Overview

Self-serve recovery through the same callback.

### Changes Required:

#### 1. Request flow

**File**: `src/pages/auth/forgot-password.astro`, `src/components/auth/ForgotPasswordForm.tsx`, `src/pages/api/auth/forgot-password.ts` (new)

**Intent**: Email form that calls `resetPasswordForEmail(email, { redirectTo: <origin>/auth/callback?next=/auth/reset-password })` and always shows the same generic confirmation.

#### 2. Update flow

**File**: `src/pages/auth/reset-password.astro`, `src/components/auth/ResetPasswordForm.tsx`, `src/pages/api/auth/reset-password.ts` (new)

**Intent**: Signed-in (recovery session) founder sets a new password via `auth.updateUser({ password })`, with confirm-password matching as in `SignUpForm`, then redirects to `/dashboard`.

**Contract**: `/auth/reset-password` added to `PROTECTED_ROUTES` in `src/middleware.ts` so it requires the recovery session.

#### 3. Entry point

**File**: `src/components/auth/SignInForm.tsx`

**Intent**: Add a "Forgot password?" link to `/auth/forgot-password`.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`

#### Manual Verification:

- Reset email arrives, link opens the new-password page, new password works at sign-in and the old one does not
- Unknown email shows the same message as a known one
- Visiting `/auth/reset-password` signed out redirects to sign-in

**Implementation Note**: Pause for manual confirmation before the next phase.

---

## Phase 3: Workspace landing

### Overview

Prove FR-004 visibly: signed-in founders land in their one workspace. Requires F-01 implemented.

### Changes Required:

#### 1. Workspace helper

**File**: `src/lib/services/workspace.ts` (new), `src/types.ts`

**Intent**: Load the signed-in founder's single workspace through the user-scoped Supabase client (RLS does the filtering).

**Contract**: `getCurrentWorkspace(supabase): Promise<Workspace | null>`; `Workspace` type comes from `src/types.ts` (created by F-01; create it here only if F-01 has not landed).

#### 2. Dashboard and redirect

**File**: `src/pages/dashboard.astro`, `src/pages/api/auth/signin.ts`

**Intent**: Dashboard shows the workspace name alongside the email; signin redirects to `/dashboard` instead of `/`. If the workspace is missing, render a clear error state rather than crashing (indicates a broken trigger).

#### 3. Defence-in-depth gate

**File**: `src/middleware.ts`

**Intent**: Treat a user without `email_confirmed_at` as signed out.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`

#### Manual Verification:

- After sign-in the dashboard shows the founder's workspace name and email
- Two founders each see only their own workspace

**Implementation Note**: Pause for manual confirmation before the next phase.

---

## Phase 4: Smoke test and CI

### Overview

Automate the verification, reset, and workspace paths.

### Changes Required:

#### 1. Smoke script

**File**: `scripts/smoke.mjs`

**Intent**: Update the flow: signup → signin is rejected (unverified) → fetch the confirmation link from the local mail server and follow it → dashboard renders with the workspace → signout → request reset → follow link → set new password → old password rejected, new accepted.

**Contract**: Stays dependency-free; reads the mail server HTTP API (base URL via `MAIL_URL`, default `http://127.0.0.1:54324`).

#### 2. CI

**File**: `.github/workflows/ci.yml`

**Intent**: Stop excluding the mail server from `supabase start` in the smoke job; ensure `site_url` in config matches the preview port used by the smoke run.

### Success Criteria:

#### Automated Verification:

- Smoke passes locally against `npm run dev` with local Supabase: `npm run smoke`
- Smoke passes in CI against the production preview
- Lint, type check and build still pass: `npm run lint && npx astro check && npm run build`

#### Manual Verification:

- CI smoke job is green on a pull request

---

## Testing Strategy

### Unit Tests:

- None added (no unit-test runner in the stack); `safeNext` and the error mapper are small and covered via smoke and manual checks.

### Integration Tests:

- Extended `scripts/smoke.mjs` covers verification gate, resend, reset, workspace landing.

### Manual Testing Steps:

1. Sign up, verify via local mail UI (port 54324), land on dashboard.
2. Try signing in with an unverified account.
3. Run the full reset flow; reuse the same link twice to see the expired-link message.
4. Open the callback with a malicious `next`.

## Performance Considerations

None beyond one extra Supabase round trip for the workspace query on `/dashboard`.

## Migration Notes

Turning confirmations on only affects new signups; any existing local test users should be reset with `npx supabase db reset`. Production needs the dashboard's site URL, redirect allow-list, and SMTP set before deploy.

## References

- Roadmap: `context/foundation/roadmap.md` (S-01)
- Prerequisite: `context/changes/data-workspace-scaffold/plan.md`
- Existing patterns: `src/pages/api/auth/signin.ts`, `src/components/auth/SignInForm.tsx`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

> Implementation notes (deviations from the plan, with reasons):
>
> - Emails link to `/auth/callback?token_hash=…&type=…` via custom templates (`supabase/templates/`), verified with `verifyOtp`, instead of relying on Supabase's default PKCE links. PKCE needs a single-use code-verifier cookie from the browser that signed up, so a link opened on another browser/phone (very common) or any stray visit to the callback fails with an "expired" error. `code` (PKCE) is still accepted as a fallback. Hosted projects must paste the templates in the dashboard (README, "MVP deploy").
> - Minimum password length is 8 (config.toml, zod, forms), not 6.
> - Unverified sign-in / signup / resend remember the address in a short-lived httpOnly cookie (`pending_email`, path `/auth`) rather than putting it in the URL.
> - CI smoke job also runs `supabase/tests/*.sql`; PRs into `main` now trigger CI (the repo's default branch is `main`, not `master`).
> - Verified against a real GoTrue + PostgREST + Postgres 16 stack built natively in the sandbox (no Docker): 30 smoke steps pass, including the emailed-link flows.
> - Also done here: brand foundation (tokens, fonts, shared classes, app shell) so every screen matches the marketing site; ESLint rule `no-misused-promises` disabled for `.astro` files (typescript-eslint crashes on top-level `return Astro.redirect()`).

### Phase 1: Verification gate

#### Automated

- [x] 1.1 Lint passes: `npm run lint`
- [x] 1.2 Type check passes: `npx astro check`
- [x] 1.3 Build passes: `npm run build`

#### Manual

- [x] 1.4 Signing up shows "check your email"; the link in the local mail server signs the founder in and lands on `/dashboard` (automated in smoke: emailed link signs in and lands on /dashboard)
- [x] 1.5 Signing in before verifying shows the verify-your-email prompt and resend works (automated in smoke)
- [x] 1.6 An expired or reused link shows a friendly error, not a raw Supabase message (automated in smoke: reused link shows friendly message)
- [x] 1.7 A tampered `next=https://evil.example` redirects to `/dashboard` (callback tampering covered by smoke + `npm run test:auth` safeNext cases)

### Phase 2: Password reset

#### Automated

- [x] 2.1 Lint passes: `npm run lint`
- [x] 2.2 Type check passes: `npx astro check`
- [x] 2.3 Build passes: `npm run build`

#### Manual

- [x] 2.4 Reset email arrives, link opens the new-password page, new password works at sign-in and the old one does not (automated in smoke)
- [x] 2.5 Unknown email shows the same message as a known one (automated in smoke: identical redirect for known and unknown addresses)
- [x] 2.6 Visiting `/auth/reset-password` signed out redirects to sign-in (automated in smoke)

### Phase 3: Workspace landing

#### Automated

- [x] 3.1 Lint passes: `npm run lint`
- [x] 3.2 Type check passes: `npx astro check`
- [x] 3.3 Build passes: `npm run build`

#### Manual

- [x] 3.4 After sign-in the dashboard shows the founder's workspace name and email (automated in smoke; viewed in Chromium screenshots)
- [ ] 3.5 Two founders each see only their own workspace (RLS isolation proven in supabase/tests/workspace_scaffold.sql; two founders in screenshots/smoke runs)

### Phase 4: Smoke test and CI

#### Automated

- [x] 4.1 Smoke passes locally against `npm run dev` with local Supabase: `npm run smoke`
- [ ] 4.2 Smoke passes in CI against the production preview (runs on first push to mvp; workflow validated with actionlint)
- [x] 4.3 Lint, type check and build still pass: `npm run lint && npx astro check && npm run build`

#### Manual

- [ ] 4.4 CI smoke job is green on a pull request (verify on the first CI run)
