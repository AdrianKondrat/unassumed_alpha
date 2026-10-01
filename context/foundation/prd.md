---
project: "Unassumed"
version: 1
status: draft
created: 2026-09-27
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
---

# Unassumed — Product Requirements

## Current System Overview

- **System purpose:** Landing page + waitlist for "Unassumed," an AI rehearsal tool for first-time founders. No product functionality is live yet beyond marketing/waitlist.
- **Key architecture:** Astro SSR app — monolith-style app with server routes, React islands for interactivity.
- **Tech stack:** Astro + React, Supabase (Postgres, Auth, RLS), Cloudflare Workers/Workflows, OpenRouter (AI provider routing), Tailwind CSS. Billing provider tentatively Paddle — may change (see hand-off notes; not a PRD decision).
- **Current user base:** None at product scale yet. Private beta targeted November 2026. A $6.99/mo "Founder Plan" (5 rehearsals/month, unlimited assumptions) is the announced pricing.
- **Core functionality today:** Landing page only, in the `unassumed_alpha` repository. A separate canvas-only prototype (`BMC_AI_Advisor`) exists with AI-assisted Business Model Canvas drafting and critique — a technical reference for the "Scribble" and "Assumption" stages described below, not yet merged into `unassumed_alpha`.

## Problem Statement & Motivation

First-time founders ask their prospective customers bad interview questions — leading, hypothetical, or solution-biased ("Would you use this?") — and get polite, uninformative answers back. An attractive canvas is not a validated business. Today, founders have nothing between a canvas prototype and a real, unscripted customer interview: no practice, no coaching on question quality, and no structured way to capture real evidence once they do talk to customers.

This change builds the first three stages of the intended four-stage product loop — **Scribble** (rough notes → structured claims) → **Assumption** (claims → named, risky, testable assumptions) → **Rehearsal** (practice the interview against an AI persona that scores question quality, not idea viability) — on a dedicated MVP branch. The fourth stage, **Evidence** (logging real customer statements with source/provenance), is explicitly deferred past this release (see Non-Goals).

The founder's own AI never judges the idea; it judges how well the founder is asking questions. No synthetic persona is ever allowed to say "validated" — this is a hard product boundary, not a technical constraint to relax later. This is the differentiator from "AI validates my idea" tools and from investor-pitch simulators.

## User & Persona

**Primary:** Solo, first-time founder with a rough, unvalidated idea, each operating in their own personal workspace. They want honest resistance and a cheap place to fail at asking bad questions — not flattery, not a "validation certificate." Explicitly _not_ the target: people looking for the product to tell them their idea will work.

**Secondary persona:** None in this release — small founding teams (multiple people sharing one workspace) are explicitly out of scope (see Non-Goals).

## Success Criteria

### Primary

- A founder can go, in one sitting, from raw notes → a structured canvas with named assumptions → one rehearsed interview against an AI persona → a scored transcript flagging leading/hypothetical/solution-biased questions.

### Secondary

- A founder can see their question quality improve across repeated rehearsals (a simple before/after or trend signal — not a full analytics dashboard).

### Guardrails

- No synthetic persona ever states or implies that the idea/business is "validated" — a hard product boundary, not a tunable setting.
- The existing marketing landing page and waitlist keep working, unchanged, throughout this build.

## User Stories

### US-01: Founder rehearses a customer interview and gets scored on question quality

- **Given** a signed-up, verified founder with a project whose canvas has at least one accepted assumption
- **When** they start a rehearsal session and exchange questions with the AI persona up to the turn cap, then end the session
- **Then** they see a scorecard within a reasonable wait, flagging leading/hypothetical/solution-biased questions with exact quoted turns, at least one concrete rewrite suggestion, and a visible "beta scoring" disclaimer — the scorecard never states or implies the idea is "validated"

#### Acceptance Criteria

- A session with zero founder turns cannot produce a scorecard implying assessment (shows a clear "not enough transcript" state instead)
- Every flagged question in the scorecard cites the exact quoted turn text and its position in the conversation
- Refreshing the browser mid-session does not duplicate or lose any already-sent turn
- No wording in the scorecard or persona response ever uses "validated," "proven," or an equivalent claim of business viability

_(This is the only user story shaping captured explicitly; it covers the MVP's primary path end-to-end. Additional stories for individual FRs below were not separately elaborated — see Open Questions if deeper acceptance criteria are needed before implementation planning.)_

## Scope of Change

### Authentication & Workspace

- [new] FR-001: Founder can sign up with email/password and must verify their email before using any product feature.
  > Socrates: Counter-argument considered — verification-before-use adds friction for a low-commitment plan. Resolution: kept; prevents throwaway accounts from consuming AI budget.
- [new] FR-002: Founder can sign in and sign out.
  > Socrates: Counter-argument considered — an undefined session-expiry policy could lose an in-progress rehearsal turn on logout. Resolution: kept a standard long-lived session; rehearsal turns are saved durably regardless of session state, so a logout doesn't lose data (see FR-017).
- [new] FR-003: Founder can reset a forgotten password (self-serve recovery).
  > Socrates: Counter-argument considered — recovery could slip to manual support given a small beta cohort. Resolution: kept as must-have; self-serve recovery is table-stakes even for a small beta.
- [new] FR-004: The system creates exactly one personal workspace and owner membership for a founder, atomically at signup, with no gap where a signed-up founder has no workspace.
  > Socrates: Counter-argument considered — a workspace abstraction may be premature structure for a solo-only release with no teams. Resolution: kept; every founder needs a stable tenant boundary from day one, and retrofitting one later is far more painful than creating an invisible default workspace now.

### Scribble

- [new] FR-005: Founder can create exactly one project from a short rough-notes brief (cap: one project per founder in this release).
  > Socrates: Counter-argument considered — a hard one-project cap may block founders exploring multiple ideas. Resolution: kept; forces focus and avoids a multi-project dashboard in this release.
- [new] FR-006: Founder can request an AI-drafted Business Model Canvas from their brief; AI-authored claims are visibly, distinctly marked from founder-authored claims.
  > Socrates: Counter-argument considered — an AI-generated canvas risks anchoring the founder on the AI's framing, undermining the "honest resistance, not flattery" positioning. Resolution: kept, with AI-authored claims clearly tagged as AI-drafted and treated as a starting point the founder must review and edit, never as authority.
- [new] FR-007: Founder can edit canvas blocks/claims manually without AI.
  > Socrates: No counter-argument raised; stands as written.
- [new] FR-008: Canvas edits are protected against silent overwrite — if two edits race against the same saved version, one is accepted and the other is flagged as a conflict rather than silently lost.
  > Socrates: Counter-argument considered — conflict handling may be over-engineering for a solo, single-device founder. Resolution: kept; cheap insurance against silent data loss.

### Assumption

- [new] FR-009: Founder can request AI-suggested assumptions derived from accepted canvas claims.
  > Socrates: Counter-argument considered — if the AI suggests the assumptions too, is the founder really doing the "name the risky guess" work themselves? Resolution: kept; AI proposes candidates only, and per FR-010 the founder must actively accept each one before it becomes durable.
- [new] FR-010: Founder can accept, edit, or reject a suggested assumption to make it a durable, tracked assumption.
  > Socrates: No counter-argument raised; stands as written — this is the human-in-the-loop gate for FR-009.
- [new] FR-011: Each assumption carries an explicit lifecycle status (active, superseded, or retired) that the founder can set manually, even before any evidence-tracking system exists.
  > Socrates: Counter-argument considered — without an evidence/decision system yet, "superseded"/"retired" may be unreachable in this release. Resolution: kept all three states; lets a founder retire or replace an assumption by hand and avoids a rework later when evidence tracking ships.
- [new] FR-012: Founder can start a rehearsal session for a chosen assumption, which prepares a hidden AI persona scenario the founder never sees directly.
  > Socrates: Counter-argument considered — the hidden-persona system is the riskiest, most expensive piece of this release; should it be simplified to de-risk the timeline? Resolution: kept a real hidden-persona system since it's the core differentiator; simplify the persona's supporting context instead, with curated fallback responses as an explicit option if usability targets are missed.

### Rehearsal

- [new] FR-013: Founder can send interview questions to the persona and receive in-character responses, within a per-session cap of 8-10 founder turns.
  > Socrates: Counter-argument considered — is a shorter cap long enough to feel like a real interview? Resolution: revised down to 8-10 turns for this release (from a longer default considered earlier) to bound cost while the core loop is validated; length can be tuned later.
- [new] FR-014: Founder can end a session early, or it ends automatically at the turn cap.
  > Socrates: No counter-argument raised; stands as written.
- [new] FR-015: An ended session is automatically scored for question quality (leading, hypothetical, solution-biased, past-behavior, specificity), citing the exact turns that triggered each flag, and is presented with a visible disclaimer that scoring is early-stage and may miss nuance.
  > Socrates: Counter-argument considered — the scoring judgment is the hardest quality problem in the product; should it ship without any caveat? Resolution: ship with a visible early-accuracy disclaimer, setting honest expectations without blocking launch.
- [new] FR-016: Founder can view the scorecard with at least one concrete rewrite suggestion.
  > Socrates: No counter-argument raised; stands as written — this is the core value-delivery moment of the release.
- [new] FR-017: A disrupted session (refresh, tab close, brief disconnect) resumes without duplicating or losing turns, up to session expiry.
  > Socrates: Counter-argument considered — robust resume handling is real engineering weight; could a disrupted session just fail gracefully instead? Resolution: kept full resume support; a founder gets only a handful of rehearsals per month on the announced plan, so losing one to a glitch directly costs them value and trust.

### Preserved

- [preserved] FR-018: The existing landing page and waitlist signup continue to work unchanged throughout this build.
  > Socrates: No counter-argument raised; stands as written — pure guardrail.

## Constraints & Compatibility

- No backward-compatibility or data-migration requirements — this is a pre-launch build with no live product data anywhere.
- The one hard constraint: the existing landing page, waitlist signup, and marketing setup must keep working unchanged throughout this build (mirrors the Guardrails above).

## Business Logic Changes

Given a founder's interview questions from a rehearsal, the system classifies each question against a fixed set of bias patterns (leading, hypothetical, solution-biased, past-behavior, specificity) and produces a per-session question-quality score with cited examples — never a judgment of the underlying business idea.

This is a new rule; nothing in the current system (landing page only) makes any comparable decision today. Inputs are the founder's own interview turns submitted during a rehearsal session; the output is a labeled, quoted breakdown plus a scorecard carrying at least one concrete rewrite suggestion. The founder encounters this immediately after ending a rehearsal session (FR-015, FR-016).

## Access Control Changes

This is a pre-launch build — there are no existing accounts to migrate, so "changes" below describes what to build, not what to preserve.

- Email + password signup and signin, with email verification and self-serve password recovery.
- Exactly one personal workspace, auto-created per founder at signup.
- This release exposes a single role: owner. No multi-member roles and no invitations to a shared workspace (small founding teams are a non-goal — see below).
- Anonymous visitors get: the landing page, a waitlist/invite step that never discloses whether an email is already registered, and optionally a curated read-only example — never access to a real founder's project data.

## Non-Goals

- **Evidence and decision tracking** (real customer quotes, source provenance, supports/contradicts) — deferred to the next release; this release stops at Rehearsal.
- **Team or multi-member workspaces** — solo founders only in this release; no invitations, no shared workspace access.
- **Live billing enforcement** — no automated checkout/subscription system built for this release; beta access is granted manually, but still recorded through the same usage-tracking system so accounting stays consistent once billing is added later.
- **Cross-founder benchmarking or percentile comparisons** — not enough data yet, and it directly conflicts with the product's anti-validation-theater positioning.
- **Multiple projects per founder** — restates FR-005's one-project cap explicitly as a non-goal.

## Open Questions

No open questions remain from shaping — every required PRD element (business rule, success criteria, FRs, access control, non-goals, timeline) was explicitly captured and confirmed with the founder. Two forward-looking notes were captured for the next chain step rather than left here; see the hand-off summary.
