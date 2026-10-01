---
project: "Unassumed"
context_type: brownfield
product_type: web-app
target_scale:
  users: small
  qps: low
  data_volume: small
timeline_budget:
  delivery_weeks: 8
  hard_deadline: 2026-11-01
  after_hours_only: true
created: 2026-09-27
updated: 2026-09-27
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "change category"
      decision: "New product build on a new MVP branch of unassumed_alpha, not a small feature bolt-on"
    - topic: "primary persona scope"
      decision: "Solo first-time founders, each in their own personal workspace; small teams out of scope for V1"
    - topic: "existing live data"
      decision: "Pre-launch — no real user accounts/data anywhere; MVP branch is a fresh build, not a migration"
    - topic: "auth model"
      decision: "Email/password signup+signin, one auto-created personal workspace per founder, owner-only role in V1"
    - topic: "MVP flow scope"
      decision: "Scribble -> Assumption -> Rehearsal only; Evidence/decisions deferred to next release"
    - topic: "timeline"
      decision: "8-week after-hours MVP, acknowledged and accepted"
    - topic: "rehearsal turn cap"
      decision: "8-10 founder turns for v0, down from the spec's default of 15"
    - topic: "scoring trust framing"
      decision: "Ship scorecard with a visible beta-accuracy disclaimer rather than presenting it as production-quality"
    - topic: "scale and deadline"
      decision: "Small scale (handful of beta founders); hard deadline November 2026 private beta"
    - topic: "non-goals"
      decision: "Evidence/Decisions, team workspaces, live billing, benchmarking, and multi-project all deferred out of v0"
  frs_drafted: 18
  quality_check_status: accepted
---

# Shape Notes — Unassumed

Seed sources:

- `Prelaunch_Analysis/MVP/Unassumed MVP/GPT_UNASSUMED MVP technical specification.md` — detailed technical spec (domain model, auth, billing, AI task contracts, implementation tickets).
- https://alpha.unassumed.co.uk — live landing page describing the product vision.
- Working repo: https://github.com/AdrianKondrat/unassumed_alpha (currently holds the landing page). MVP development happens on a separate branch. The previously-inspected `BMC_AI_Advisor` repo is a canvas-only prototype that serves as technical baseline/reference for the Scribble + Assumption stages, not the repo being worked in.

## Current System Overview

- **System purpose:** Landing page + waitlist for "Unassumed," an AI rehearsal tool for first-time founders. No product functionality is live yet beyond marketing/waitlist.
- **Key architecture:** Astro SSR app (per spec baseline) — monolith-style app with server routes, React islands for interactivity.
- **Tech stack:** Astro + React, Supabase (Postgres, Auth, RLS), Cloudflare Workers/Workflows, OpenRouter (AI provider routing), Tailwind CSS. Billing provider tentatively Paddle — may change (see `## Forward: tech-stack` below).
- **Current user base:** None at product scale yet. Private beta targeted November 2026 (per landing page). $6.99/mo "Founder Plan" (5 rehearsals/month, unlimited assumptions) is the announced pricing.
- **Core functionality today:** Landing page only, in `unassumed_alpha` repo. A separate canvas-only prototype (`BMC_AI_Advisor`) exists with AI-assisted Business Model Canvas drafting + critique — this is a technical reference/baseline for the "Scribble" and "Assumption" stages, not yet merged into `unassumed_alpha`.

## Problem Statement & Motivation

First-time founders ask their prospective customers bad interview questions — leading, hypothetical, or solution-biased ("Would you use this?") — and get polite, uninformative answers back. "An attractive canvas is not a validated business." Today, founders have nothing between a canvas prototype and a real, unscripted customer interview: no practice, no coaching on question quality, and no structured way to capture real evidence with provenance once they do talk to customers.

This change builds the full four-stage product loop — **Scribble** (rough notes → structured claims) → **Assumption** (claims → named, risky, testable assumptions) → **Rehearsal** (practice the interview against an AI persona that scores question quality, not idea viability) → **Evidence** (log real customer statements with source/provenance, assess assumptions) — into the `unassumed_alpha` repo, on a dedicated MVP branch.

**Insight:** The AI's job is to score the _founder's questioning skill_, never the idea's viability. No synthetic persona is ever allowed to say "validated" — this is a hard product boundary, not a technical constraint to relax later. This is the differentiator from "AI validates my idea" tools and from investor-pitch simulators.

## User & Persona

**Primary:** Solo, first-time founder with a rough, unvalidated idea, each operating in their own personal workspace (one workspace per founder, per the domain model). They want honest resistance and a cheap place to fail at asking bad questions — not flattery, not a "validation certificate." Explicitly _not_ the target: people looking for the product to tell them their idea will work.

**Secondary persona:** None in V1 — small founding teams (multiple people per workspace) are explicitly out of scope for now (see Non-Goals).

## Access Control Changes

Pre-launch: no real user accounts or data exist yet on `unassumed_alpha` or in `BMC_AI_Advisor`. This is a fresh build of the auth/access model on the MVP branch, not a migration — so "changes" here means "what to build," not "what to preserve."

- Email + password signup/signin (with email verification and password recovery — noted as incomplete in the spec's baseline audit; must be completed for MVP).
- One personal workspace auto-created per founder, atomically with signup. Exactly one personal workspace per founder (unique constraint).
- V1 exposes a single role: `owner`. No team/multi-member roles, no invitations to a shared workspace in V1 (small founding teams are a non-goal — see below).
- Anonymous visitors get: landing page, waitlist/invite preflight (no email enumeration), and optionally a curated read-only example — no access to real project data.

## Success Criteria

### Primary

- A founder can go, in one sitting, from raw notes → a structured canvas with named assumptions → one rehearsed interview against an AI persona → a scored transcript flagging leading/hypothetical/solution-biased questions.

### Secondary

- A founder can see their question quality improve across repeated rehearsals (a simple before/after or trend signal — not a full analytics dashboard).

### Guardrails

- No synthetic persona ever states or implies that the idea/business is "validated" — this is a hard product boundary, not a tunable setting.
- The existing marketing landing page and waitlist on `unassumed_alpha`'s main branch are never disrupted by MVP-branch work.

## Timeline acknowledgment

Acknowledged on 2026-09-27: an 8-week MVP (Scribble → Assumption → Rehearsal, including auth, AI canvas draft/critique, assumption extraction, a hidden-persona rehearsal engine with question scoring, and job/queue plumbing) requires sustained after-hours dedication; user accepted. Evidence logging and assumption decisions (real customer quotes, provenance, supports/contradicts) are explicitly deferred past this first release.

## Scope of Change

### Authentication & Workspace

- FR-001: Founder can sign up with email/password and must verify their email before using any product feature. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: verification-before-use adds friction for a low-commitment $6.99 plan. Resolution: kept — prevents throwaway accounts consuming AI budget.
- FR-002: Founder can sign in and sign out. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: no session-expiry policy could lose an in-progress rehearsal turn on logout. Resolution: kept as standard long-lived session — rehearsal turns are server-persisted per FR-017, so a logout doesn't lose data.
- FR-003: Founder can reset a forgotten password (self-serve recovery). Priority: must-have. Change: new
  > Socrates: Counter-argument considered: recovery could slip to manual support given a small beta cohort. Resolution: kept as must-have — self-serve recovery is table-stakes even for a small beta.
- FR-004: System auto-creates exactly one personal workspace and owner membership atomically at signup. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: the workspace abstraction may be premature structure for a solo-only V1 with no teams. Resolution: kept — every table keys off `workspace_id`; retrofitting a tenant boundary later is far more painful than creating one invisible workspace now.

### Scribble

- FR-005: Founder can create exactly one project per workspace from a short rough-notes brief (V1 cap: one project). Priority: must-have. Change: new
  > Socrates: Counter-argument considered: a hard 1-project cap may block founders exploring multiple ideas. Resolution: kept — forces focus, matches the product's "an attractive canvas is not a validated business" ethos and avoids a multi-project dashboard in v0.
- FR-006: Founder can request an AI-drafted Business Model Canvas from their brief; AI-authored claims are visibly marked as such (distinct from founder-authored claims). Priority: must-have. Change: new
  > Socrates: Counter-argument considered: an AI-generated canvas risks anchoring the founder on the AI's framing, undermining the "honest resistance, not flattery" positioning. Resolution: kept, but AI-authored claims must be visibly marked (`origin: ai_draft`) and treated as a starting point the founder must review/edit, not authority.
- FR-007: Founder can edit canvas blocks/claims manually without AI. Priority: must-have. Change: new
  > Socrates: No counter-argument raised; stands as written.
- FR-008: Canvas edits save with revision tracking; two tabs saving the same revision yield one accepted update and one conflict. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: multi-tab conflict handling may be over-engineering for a solo, single-device user. Resolution: kept — cheap insurance directly fixing the spec's flagged bug (tab-local save not preventing cross-tab overwrites).

### Assumption

- FR-009: Founder can request AI-suggested assumptions derived from accepted canvas claims. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: if AI suggests the assumptions too, is the founder really doing the "naming the risky guess" work themselves? Resolution: kept — AI proposes candidates only; per FR-010 the founder must actively accept each one before it becomes durable.
- FR-010: Founder can accept, edit, or reject a suggested assumption to make it a durable, tracked assumption. Priority: must-have. Change: new
  > Socrates: No counter-argument raised; stands as written — this is the human-in-the-loop gate for FR-009.
- FR-011: Each assumption carries an explicit lifecycle status: active, superseded, or retired, settable manually by the founder even before any Evidence/Decision system exists. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: without Evidence/Decisions (deferred), "superseded"/"retired" may be unreachable dead schema in v0. Resolution: kept all three states — founder can manually retire/replace an assumption by hand, avoiding a schema migration later.
- FR-012: Founder can start a rehearsal session for a chosen assumption, which prepares a hidden AI persona scenario server-side. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: the hidden-persona system is the riskiest, most expensive piece of the MVP — should v0 use a simpler, less "intelligent" persona? Resolution: kept a real hidden-persona system since it's the core differentiator; de-risk by simplifying context/grounding sources instead of the persona concept, with curated answer templates as an explicit fallback if usability targets are missed.

### Rehearsal

- FR-013: Founder can send interview questions to the persona and receive in-character responses, within a per-session turn cap of 8-10 founder turns (reduced from the spec's default of 15 for v0, to bound AI cost while the core loop is validated). Priority: must-have. Change: new
  > Socrates: Counter-argument considered: is 15 turns the right length to feel like a real interview? Resolution: revised down to 8-10 turns for v0 — tighter cap reduces AI cost and validates the core loop faster before tuning length.
- FR-014: Founder can end a session early, or it ends automatically at the turn cap. Priority: must-have. Change: new
  > Socrates: No counter-argument raised; stands as written.
- FR-015: An ended session is automatically scored for question quality (leading, hypothetical, solution-biased, past-behavior, specificity), citing exact quoted turns, and is presented with a visible "beta scoring, may miss nuance" disclaimer. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: the scoring classifier is the hardest AI-quality problem in the product — should it ship without caveat, as production-quality? Resolution: ship with a visible beta-accuracy disclaimer — sets honest expectations without blocking launch, matching the product's own "we don't oversell certainty" stance.
- FR-016: Founder can view the scorecard with at least one concrete rewrite suggestion. Priority: must-have. Change: new
  > Socrates: No counter-argument raised; stands as written — this is the core value-delivery moment of the MVP.
- FR-017: A disrupted session (refresh, tab close, brief disconnect) resumes without duplicating or losing turns, up to session expiry. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: robust reconnect/idempotency (leases, fencing tokens) is real engineering weight — could v0 just fail the session gracefully instead? Resolution: kept full resume support — a founder gets only 5 rehearsals/month on the announced plan, so losing one to a glitch directly costs them value and trust.

### Preserved

- FR-018: The existing landing page and waitlist on `unassumed_alpha`'s main branch continue to work unchanged throughout MVP-branch development. Priority: must-have. Change: preserved
  > Socrates: No counter-argument raised; stands as written — pure guardrail.

## User Stories

### US-01: Founder rehearses a customer interview and gets scored on question quality

- **Given** a signed-up, verified founder with a project whose canvas has at least one accepted assumption
- **When** they start a rehearsal session and exchange questions with the AI persona up to the turn cap, then end the session
- **Then** they see a scorecard within a reasonable wait, flagging leading/hypothetical/solution-biased questions with exact quoted turns, at least one concrete rewrite suggestion, and a visible "beta scoring" disclaimer — the scorecard never states or implies the idea is "validated"

#### Acceptance Criteria

- A session with zero founder turns cannot produce a scorecard implying assessment (shows a clear "not enough transcript" state instead)
- Every flagged question in the scorecard cites the exact quoted turn text and sequence number
- Refreshing the browser mid-session does not duplicate or lose any already-sent turn
- No wording in the scorecard or persona response ever uses "validated," "proven," or equivalent claims of business viability

## Business Logic Changes

Given a founder's interview questions from a rehearsal, the system classifies each question against a fixed set of bias patterns (leading, hypothetical, solution-biased, past-behavior, specificity) and produces a per-session question-quality score with cited examples — never a judgment of the underlying business idea.

This is a new rule (`unassumed_alpha` currently has none — it's landing-page only). Inputs are the founder's submitted interview turns within a rehearsal session; output is a labeled, quoted breakdown plus a scorecard with at least one concrete rewrite suggestion. The founder encounters this immediately after ending a rehearsal session (FR-015/FR-016).

## Non-Functional Requirements

- Turn acceptance responds within 1 second under normal service health; persona reply p50 ~3 seconds, p95 under 8 seconds; scorecard is normally available within 30 seconds of ending a session.
- Hidden persona scenario details never leave the server — absent from SSR props, API responses, and telemetry.
- Founder interview content sent to the AI provider is never used for third-party model training or retained beyond the request that consumes it.
- A failed canvas save never allows AI generation (draft, assumption suggestion, or critique) to proceed on stale or lost text — save failure blocks generation with a recoverable message.

## Constraints & Compatibility

- No backward compatibility or data migration needed — pre-launch, no live product data.
- The only hard constraint: the existing landing page, waitlist signup, and marketing setup on `unassumed_alpha`'s main branch must keep working unchanged throughout MVP-branch development (mirrors the Guardrails in Success Criteria).

## Non-Goals

- **Evidence/Decision stage** (real customer quotes, provenance, supports/contradicts) — deferred to the next release; v0 stops at Rehearsal.
- **Team/multi-member workspaces or shared projects** — solo founders only in v0; no invitations, no shared workspace access.
- **Live billing enforcement** — no Paddle (or other provider) checkout/webhook/entitlement system built for v0; beta access is granted manually via a config flag, still recorded through the usage ledger so accounting stays consistent when billing is added later.
- **Cross-founder benchmarking or percentile comparisons** — not enough data yet, and directly conflicts with the product's anti-validation-theater positioning.
- **Multiple projects per workspace** — restates FR-005's one-project-per-workspace cap explicitly as a non-goal.

## Forward: tech-stack

- Billing provider may change from Paddle — not yet decided, do not lock in at PRD stage. Revisit during tech-stack selection / when the billing stage is actually scoped.
- AI provider routing (OpenRouter, model choice) may also be revisited during tech-stack selection.
