---
project: "Unassumed"
version: 1
status: draft
created: 2026-09-27
updated: 2026-10-01
prd_version: 1
main_goal: market-feedback
top_blocker: capacity
---

# Roadmap: Unassumed

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Vision recap

First-time founders tend to ask their prospective customers leading, hypothetical, or solution-biased questions and get back polite, uninformative answers — an attractive canvas is not a validated business. Unassumed builds the first three stages of a four-stage founder-coaching loop: Scribble (rough notes → structured claims), Assumption (claims → named, testable assumptions), and Rehearsal (practice an interview against an AI persona that scores question quality, never the idea itself). The AI never says an idea is "validated" — a hard product boundary, not a setting — which is what separates this from "AI validates my idea" tools.

## North star

**S-06: Founder receives a scorecard after a rehearsed interview** — flagging leading/hypothetical/solution-biased questions with exact quoted turns and at least one concrete rewrite suggestion, and never implying the idea itself is "validated".

> A reader-facing one-liner: the north star is the smallest end-to-end slice whose successful delivery would prove the product's core hypothesis — here, that founders can meaningfully improve their interview-question quality through AI-scored rehearsal, without any synthetic verdict on the idea itself. It's placed as early as its Prerequisites allow, because everything upstream (account, canvas, assumptions) only matters if this final step actually delivers that value.

## At a glance

| ID   | Change ID                                  | Outcome (user can …)                                                                                          | Prerequisites | PRD refs                       | Status |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------ | ------ |
| F-01 | data-workspace-scaffold                    | (foundation) Supabase migration tooling + minimal founder/workspace schema                                    | —             | FR-004                         | done   |
| F-02 | ai-provider-integration                    | (foundation) server-only AI-provider call path; secrets/persona never client-side                             | —             | NFR (privacy/latency)          | done   |
| F-03 | mvp-branch-deploy-pipeline                 | (foundation) CI deploys the MVP branch to its own Cloudflare Workers environment (the `unassumed-mvp` Worker) | —             | FR-018                         | built  |
| S-01 | verified-account-and-workspace             | sign up, verify email, sign in/out, reset password, land in own workspace                                     | F-01          | FR-001, FR-002, FR-003, FR-004 | done   |
| S-02 | ai-drafted-canvas-from-brief               | create the one project from a brief and get an AI-drafted canvas                                              | S-01, F-02    | FR-005, FR-006                 | done   |
| S-03 | manual-canvas-editing-with-conflict-safety | edit canvas claims manually with edits protected against silent overwrite                                     | S-02          | FR-007, FR-008                 | ready  |
| S-04 | assumption-suggestion-and-lifecycle        | request AI-suggested assumptions, accept/edit/reject them, set lifecycle status                               | S-02, F-02    | FR-009, FR-010, FR-011         | ready  |
| S-05 | rehearsal-session-turn-exchange            | start a rehearsal session and exchange turns with the hidden persona                                          | S-04, F-02    | FR-012, FR-013, FR-014         | ready  |
| S-06 | rehearsal-scorecard                        | see the scored transcript with flags, quotes, and a rewrite suggestion                                        | S-05, F-02    | FR-015, FR-016, US-01          | ready  |
| S-07 | resumable-rehearsal-sessions               | resume a disrupted session without losing or duplicating turns                                                | S-05          | FR-017                         | ready  |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme                               | Chain                                        | Note                                                                                            |
| ------ | ----------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A      | Account & workspace                 | `F-01` → `S-01`                              | The tenant boundary everything else keys off; smallest possible first foundation.               |
| B      | Scribble: canvas creation & editing | `F-02` → `S-02` → (`S-03` / `S-04` parallel) | Joins Stream A at `S-01`. `S-03` and `S-04` don't depend on each other — buildable in parallel. |
| C      | Rehearsal: the north star           | `S-05` → `S-06` / `S-07`                     | Joins Stream B at `S-04`. `S-06` and `S-07` branch off `S-05` independently.                    |
| D      | Ship pipeline                       | `F-03`                                       | Standalone; no downstream slice can reach real founders without it.                             |

## Baseline

> Superseded by progress on `mvp`: F-01, F-02, F-03, S-01 are implemented (see `## Done` and `context/foundation/handoff.md`). The baseline below is the original 2026-09-27 starting point.

What's already in place in the codebase as of 2026-09-27 (auto-researched + user-confirmed). Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present — Astro 7 + React 19 + Tailwind 4 + shadcn/ui scaffold (from the `10x-astro-starter` bootstrap); auth pages/forms already wired (`src/pages/auth/*`, `src/components/auth/*`); only one shadcn primitive (`button.tsx`) installed beyond that.
- **Backend / API:** present — Astro server output + Cloudflare adapter (`astro.config.mjs`); API routes for signin/signup/signout (`src/pages/api/auth/*.ts`); `src/middleware.ts` wires request-scoped auth context.
- **Data:** absent — a Supabase client is configured (`src/lib/supabase.ts`) but `supabase/` has no `migrations/` directory and no `seed.sql`; zero table definitions for this product's domain.
- **Auth:** partial — signup/signin/signout are real, functional Supabase calls, and `/dashboard` is guarded by middleware. But `confirm-email.astro` is a static notice with no verification-callback route, and password reset is entirely absent.
- **Deploy / infra:** partial — Cloudflare adapter + `wrangler.jsonc` present; CI runs lint/build/smoke (`.github/workflows/ci.yml`) but has no deploy step; no background-job/queue infra scaffolded yet.
- **Observability:** absent — no logging library, no error tracking, no metrics/dashboards.

## Foundations

### F-01: Data & workspace scaffold

- **Outcome:** (foundation) Supabase migration tooling is stood up, plus the minimal founder/workspace schema FR-004 needs (atomic workspace + owner-membership creation at signup). Not the full domain schema — canvas, assumption, and rehearsal tables are introduced later, inside the first slice that needs each.
- **Change ID:** data-workspace-scaffold
- **PRD refs:** FR-004
- **Unlocks:** S-01, and establishes the migration/RLS pattern every later slice's own schema work builds on.
- **Prerequisites:** —
- **Parallel with:** F-02, F-03
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Baseline shows zero migrations today (not even the config-referenced `seed.sql` exists) — everything downstream depends on this landing correctly and early, so it's sequenced first among foundations.
- **Status:** done — implemented on `mvp` (commit 4046359); SQL assertions mutation-checked.

### F-02: AI provider integration

- **Outcome:** (foundation) a working server-only AI-provider call path (OpenRouter or equivalent) exists, with hidden-persona and prompt details never surfacing in SSR props, API responses, or telemetry. Not the actual drafting/suggestion/scoring prompts themselves — those live in the slices that consume this path.
- **Change ID:** ai-provider-integration
- **PRD refs:** NFR (persona details never leave the server; founder content never used for training or retained beyond the request)
- **Unlocks:** S-02, S-04, S-05, S-06 — every AI-touching slice reuses this call path, including the north star (S-06).
- **Prerequisites:** —
- **Parallel with:** F-01, F-03
- **Blockers:** —
- **Unknowns:** Which OpenRouter model(s) power each task, and whether generation tasks (drafting, suggesting) should use a different model than the classification task (scoring) — see `## Open Roadmap Questions`. Not blocking: this foundation can start with a reasonable default model and adjust.
- **Risk:** This is the single most-reused piece of new infrastructure in the release — get the secret-handling and no-leak pattern right once here rather than re-solving it per slice.
- **Status:** done — implemented on `mvp` (commit e48ac56). One manual check remains: a live call with the real key from a machine that can reach openrouter.ai (blocked in the build sandbox).

### F-03: MVP-branch deploy pipeline

- **Outcome:** (foundation) pushing to the MVP branch automatically deploys the app to its own Cloudflare Workers environment (the `unassumed-mvp` Worker), separate from the `unassumed_alpha` main branch that serves the live landing page and waitlist.
- **Change ID:** mvp-branch-deploy-pipeline
- **PRD refs:** FR-018
- **Unlocks:** a real-world verification path for every S-NN once deployed; protects FR-018 by keeping MVP-branch deploys isolated from the main branch's live marketing site.
- **Prerequisites:** —
- **Parallel with:** F-01, F-02
- **Blockers:** —
- **Unknowns:** —
- **Risk:** CI today only lints/builds/smoke-tests — there's no deploy job at all, so nothing can reach even the founder for feedback (the whole point of `main_goal: market-feedback`) until this exists.
- **Status:** built — workflow and Worker config landed on `mvp` (commit 7d83f26, actionlint-clean, `wrangler deploy --dry-run` verified). Becomes `done` after the first real deploy: set the GitHub secrets listed in README "MVP deploy" and push to `mvp`.

## Slices

### S-01: Verified account and workspace

- **Outcome:** founder can sign up, verify their email, sign in/out, reset a forgotten password, and land in exactly one auto-created personal workspace.
- **Change ID:** verified-account-and-workspace
- **PRD refs:** FR-001, FR-002, FR-003, FR-004
- **Prerequisites:** F-01
- **Parallel with:** F-02, F-03
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Sign-in/sign-up/sign-out already work (starter scaffold); the real gap is closing FR-001's verification gate and FR-003's password reset, and wiring FR-004's atomic workspace creation on top of F-01 — sequenced first because every other slice needs an authenticated, workspaced founder.
- **Status:** done — implemented on `mvp` (commit 5f4ba65); 30-step smoke test passes against a real GoTrue. Hosted-project steps (site URL, redirect URL, email templates, SMTP) are in README "MVP deploy".

### S-02: AI-drafted canvas from brief

- **Outcome:** founder can create their one project from a short rough-notes brief and get an AI-drafted Business Model Canvas, with AI-authored claims visibly and distinctly marked from founder-authored ones.
- **Change ID:** ai-drafted-canvas-from-brief
- **PRD refs:** FR-005, FR-006
- **Prerequisites:** S-01, F-02
- **Parallel with:** F-03 (if not yet finished)
- **Blockers:** —
- **Unknowns:** —
- **Risk:** The AI-drafted claims must read as a clearly-marked starting point, not authority — getting the visual/data distinction right here protects the product's "honest resistance, not flattery" positioning for everything downstream.
- **Status:** done — implemented on `mvp`; verified end to end against the fake provider. Live-model check pending (see handoff).

### S-03: Manual canvas editing with conflict safety

- **Outcome:** founder can edit canvas blocks/claims manually without AI, and a race between two edits to the same saved version yields one accepted update and one flagged conflict instead of silent data loss.
- **Change ID:** manual-canvas-editing-with-conflict-safety
- **PRD refs:** FR-007, FR-008
- **Prerequisites:** S-02
- **Parallel with:** S-04
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Conflict handling is cheap insurance against silent loss, not a complex feature — doesn't need to block S-04, since assumption-suggestion only needs canvas claims to exist, not the editing UI itself.
- **Status:** ready — plan needs reconciling with S-02's real schema first (see handoff).

### S-04: Assumption suggestion and lifecycle

- **Outcome:** founder can request AI-suggested assumptions derived from accepted canvas claims, accept/edit/reject each one to make it durable, and manually set an assumption's lifecycle status (active, superseded, retired).
- **Change ID:** assumption-suggestion-and-lifecycle
- **PRD refs:** FR-009, FR-010, FR-011
- **Prerequisites:** S-02, F-02
- **Parallel with:** S-03
- **Blockers:** —
- **Unknowns:** —
- **Risk:** FR-009's AI suggestions only matter if FR-010's accept/edit/reject gate is real — the human-in-the-loop step is what keeps this "founder names the risky guess," not the AI.
- **Status:** ready

### S-05: Rehearsal session turn exchange

- **Outcome:** founder can start a rehearsal session for a chosen assumption, exchange questions with the hidden AI persona up to the 8-10 turn cap, and end the session early or automatically at the cap.
- **Change ID:** rehearsal-session-turn-exchange
- **PRD refs:** FR-012, FR-013, FR-014
- **Prerequisites:** S-04, F-02
- **Parallel with:** S-03 (if still in progress)
- **Blockers:** —
- **Unknowns:** —
- **Risk:** The hidden-persona system is the riskiest, most novel piece of the release; the PRD's own fallback (curated response templates) is an explicit option here if usability targets are missed under the capacity constraint.
- **Status:** ready — plan needs two small reconciliations first (see handoff).

### S-06: Rehearsal scorecard _(north star)_

- **Outcome:** after ending a session, founder automatically sees a scorecard flagging leading/hypothetical/solution-biased/past-behavior/specificity issues, citing the exact triggering turns, with at least one concrete rewrite suggestion and a visible "beta scoring" disclaimer — never stating or implying the idea is "validated."
- **Change ID:** rehearsal-scorecard
- **PRD refs:** FR-015, FR-016, US-01
- **Prerequisites:** S-05, F-02
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - ~~Can persona-turn scoring complete synchronously within Workers limits?~~ Resolved (`context/changes/rehearsal-scorecard/research.md`): yes on the Workers Paid plan with one batched call and a shared ~25s deadline; no Workflow/queue. Remaining check: measure p95 against the real model (plan Phase 5).
- **Risk:** This is the core value-delivery moment of the whole release and the PRD's Primary Success Criterion in miniature — it's also the one place the tech-stack hand-off flagged an unresolved architecture question (edge runtime vs. background job) that must be settled before this slice can be planned.
- **Status:** ready — the edge-runtime Unknown is resolved: synchronous batched scoring (see its plan and research.md). Plan needs reconciling with S-05's real columns first.

### S-07: Resumable rehearsal sessions

- **Outcome:** a disrupted session (refresh, tab close, brief disconnect) resumes without duplicating or losing any already-sent turn, up to session expiry.
- **Change ID:** resumable-rehearsal-sessions
- **PRD refs:** FR-017
- **Prerequisites:** S-05
- **Parallel with:** S-06
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Real engineering weight (idempotent resume), but not required to prove the core hypothesis in one uninterrupted sitting — sequenced after the north star so the core loop's value gets validated before hardening reliability, consistent with `main_goal: market-feedback`.
- **Status:** ready — plan written (`context/changes/resumable-rehearsal-sessions/plan.md`); implement after S-05 (it is an additive migration plus edits to S-05's files, and reconciles against S-05's real names).

## Backlog Handoff

| Roadmap ID | Change ID                                  | Suggested issue title                                            | Ready for `/10x-plan` | Notes                                              |
| ---------- | ------------------------------------------ | ---------------------------------------------------------------- | --------------------- | -------------------------------------------------- |
| F-01       | data-workspace-scaffold                    | Stand up Supabase migrations + minimal workspace schema          | done                  | Implemented                                        |
| F-02       | ai-provider-integration                    | Wire server-only AI-provider call path (OpenRouter)              | done                  | Implemented; unlocks the north star                |
| F-03       | mvp-branch-deploy-pipeline                 | Add Cloudflare Workers deploy step to CI for the MVP branch      | built                 | Needs secrets + first push to `mvp` to confirm     |
| S-01       | verified-account-and-workspace             | Close auth gaps (email verification, password reset) + workspace | done                  | Implemented                                        |
| S-02       | ai-drafted-canvas-from-brief               | Project creation + AI-drafted canvas                             | done                  | Implemented                                        |
| S-03       | manual-canvas-editing-with-conflict-safety | Manual canvas editing with conflict-safe saves                   | no                    | Ready after S-02; reconcile plan first             |
| S-04       | assumption-suggestion-and-lifecycle        | AI-suggested assumptions + accept/edit/reject + lifecycle status | no                    | Ready after S-02; plan exists                      |
| S-05       | rehearsal-session-turn-exchange            | Hidden-persona rehearsal session turn exchange                   | no                    | Ready after S-04; reconcile plan first             |
| S-06       | rehearsal-scorecard                        | Automatic post-session scorecard with cited flags                | no                    | Ready after S-05; Unknown resolved; reconcile plan |
| S-07       | resumable-rehearsal-sessions               | Idempotent resume for disrupted rehearsal sessions               | no                    | Plan exists; after S-05                            |

## Open Roadmap Questions

1. **Which OpenRouter model(s) should power canvas drafting, assumption suggestion, and persona/scoring — and should the generation tasks (drafting, suggesting) use a different model than the classification task (scoring) for cost/quality reasons?** — Owner: team. Block: F-02, S-02, S-04, S-05 (informational only — F-02 can proceed with a reasonable default and adjust; not a hard blocker).
2. **Can persona-turn scoring complete within Cloudflare Workers' edge execution-time limits synchronously, or does it need a Workflow/queue to reliably hit the ≤30-second scorecard NFR?** — Owner: team. Block: S-06.

## Parked

- **Evidence and decision tracking** (real customer quotes, source provenance, supports/contradicts) — Why parked: PRD Non-Goals; deferred to the next release, this release stops at Rehearsal.
- **Team or multi-member workspaces** — Why parked: PRD Non-Goals; solo founders only in this release.
- **Live billing enforcement** — Why parked: PRD Non-Goals; no automated checkout/subscription system this release — beta access is granted manually but still recorded through the usage-tracking system so accounting stays consistent once billing ships.
- **Cross-founder benchmarking or percentile comparisons** — Why parked: PRD Non-Goals; not enough data yet, and conflicts with the product's anti-validation-theater positioning.
- **Multiple projects per founder** — Why parked: PRD Non-Goals; restates FR-005's one-project cap.
- **Dedicated observability / error tracking** (Sentry, structured logging, metrics dashboards) — Why parked: baseline shows this entirely absent and no NFR gates it at this small-scale private-beta stage; with capacity as the top blocker, rely on Cloudflare/Supabase's built-in logs for now and revisit only if a real incident demands it.

## Done

- **F-01 data-workspace-scaffold** — workspaces + owner membership created atomically by a signup trigger, RLS pattern, SQL assertions. 2026-10-01.
- **F-02 ai-provider-integration** — server-only OpenRouter call path, zero-data-retention flag on every request, usage ledger, offline tests. 2026-10-01 (live-key check pending).
- **S-01 verified-account-and-workspace** — mandatory email verification, resend, password reset, workspace landing, brand foundation, end-to-end smoke test. 2026-10-01.
- **S-02 ai-drafted-canvas-from-brief** — one project from a brief, AI-drafted 9-block canvas with distinct AI-draft markers, DB-enforced one-project cap, race-safe drafting lease. 2026-10-01 (live-key check pending).
- **F-03 mvp-branch-deploy-pipeline** — built, awaiting first real deploy (see item status).
