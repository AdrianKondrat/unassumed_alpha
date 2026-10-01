# Verified Account and Workspace — Plan Brief

> Full plan: `context/changes/verified-account-and-workspace/plan.md`

## What & Why

Make the starter's auth real for founders: mandatory email verification (FR-001), self-serve password reset (FR-003), and a landing on their one auto-created workspace (FR-004). Every later slice needs an authenticated, workspaced founder. This is roadmap slice S-01.

## Starting Point

Sign in/up/out work, but confirmations are off, there is no verification callback, no reset flow, and the dashboard shows only an email. The workspace schema (F-01) is planned but not yet implemented.

## Desired End State

A founder signs up, verifies via emailed link, lands signed in on a dashboard showing their workspace, and can reset or resend by email. Smoke test in CI proves it.

## Key Decisions Made

| Decision | Choice | Why |
| --- | --- | --- |
| Verification gate | Supabase `enable_confirmations = true` | Enforced by Supabase, not bypassable by app bugs |
| Email link handling | `/auth/callback` exchanges code, signs in, → dashboard | Smoothest UX, standard SSR pattern |
| Password reset | Forgot + reset pages through the same callback | Reuses one route, generic anti-enumeration message |
| Landing | `/dashboard` shows workspace name + email | Makes FR-004 visibly true end to end |
| Errors | `?error=` redirects with mapped friendly copy | Matches existing pattern, guides recovery |
| Testing | Extend `smoke.mjs` using the local mail server | Dependency-free, runs in existing CI |
| Scope | zod on auth routes + resend endpoint; rate limiting via Supabase config only; no CAPTCHA | CAPTCHA adds a dependency/secret and capacity is the top blocker |
| Sequencing | Plan now, implement after F-01 | Roadmap order; planning isn't blocked |

## Scope

**In scope:** verification gate, callback, resend, reset flow, workspace dashboard, zod validation, smoke/CI.
**Out of scope:** CAPTCHA, social/magic-link/MFA, workspace schema (F-01), custom SMTP/templates.

## Architecture / Approach

Form POST → API route → `?error=` redirect, as today. Shared helpers in `src/lib/auth.ts` (error mapping, safe redirect, zod). One `/auth/callback` serves both verification and recovery links.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Verification gate | Config, callback, resend, friendly errors | Redirect URL/port mismatch breaks email links |
| 2. Password reset | Forgot + reset pages and routes | Recovery session handling |
| 3. Workspace landing | Dashboard shows workspace | Depends on F-01 landing first |
| 4. Smoke + CI | End-to-end email flow coverage | CI mail server naming/config |

**Prerequisites:** F-01 implemented (Phase 3 needs it); Docker for local Supabase.
**Estimated effort:** ~2 sessions across 4 phases.

## Open Risks & Assumptions

- Production needs site URL, redirect allow-list and SMTP configured in Supabase before deploy.
- Assumes the CLI's local mail server is reachable over HTTP in CI once no longer excluded.

## Success Criteria (Summary)

- Unverified founders cannot sign in; verified ones land on their workspace.
- Reset and resend work and don't reveal which emails have accounts.
- `npm run smoke` covers the full flow in CI.
