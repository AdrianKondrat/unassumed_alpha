# Assumption Suggestion and Lifecycle — Plan Brief

> Full plan: `context/changes/assumption-suggestion-and-lifecycle/plan.md`

## What & Why

A founder asks for AI-suggested assumptions derived from their canvas, then accepts, edits, or rejects each one; accepted assumptions get a manually set lifecycle status (active, superseded, retired). This is roadmap slice S-04 (FR-009, FR-010, FR-011). The accept/reject gate is the point: the AI only proposes, so naming the risky guess stays a human act.

## Starting Point

No domain schema, AI client, or `src/types.ts` exists in the repo yet. F-01, F-02 and S-02 are planned but not implemented, so this plan builds on their planned contracts: `is_workspace_member()`, `complete({ taskKind: "suggest" })`, and the `projects` / `canvas_claims` tables. S-02 has no "accepted claim" concept.

## Desired End State

On `/assumptions`, a founder with a drafted canvas presses one button and gets 5-8 pending candidates, each with a risk note and its source claims. They accept (optionally after editing) or reject each. Accepted ones form a durable list whose status the founder can set freely among active, superseded and retired. State survives reload, and failures are recoverable with Retry.

## Key Decisions Made

| Decision                 | Choice                                                        | Why (1 sentence)                                                                        |
| ------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| "Accepted canvas claims" | All existing claims are eligible                              | Avoids reopening S-02's schema and adding a gate before the founder reaches Assumption. |
| Suggest UX               | One button, one batch of 5-8                                  | One bounded AI call that fits F-02's 15s `suggest` timeout.                             |
| Pending storage          | Same `assumptions` table, `status = 'suggested'`              | Suggestions survive reload with one table and one policy set.                           |
| Reject                   | Status `rejected`, row kept                                   | Lets the next batch avoid repeating rejected ideas.                                     |
| Assumption shape         | Statement + risk note + source-claim links                    | Gives S-05's persona real context and keeps provenance.                                 |
| Lifecycle                | Free manual set among the 3 states                            | Matches FR-011 ("set manually"); no dead ends before evidence tracking exists.          |
| Spend control            | New batch only when pending is resolved, plus in-flight guard | Bounds cost structurally without counters, reusing S-02's race-guard pattern.           |
| Verification             | Fixture parser test + rolled-back SQL RLS test                | Matches repo convention, no new dependencies.                                           |

## Scope

**In scope:** `assumptions` + `assumption_claims` schema with RLS, suggestion prompt/parser/service, suggest/review/status routes, `/assumptions` page, entry link.

**Out of scope:** founder-authored assumptions, editing after acceptance, deletion, per-block or free-form suggest, hard caps, claim confirm step, evidence/decisions, replacement links for `superseded`, anything rehearsal, HTTP-level smoke extension.

## Architecture / Approach

One `assumptions` table with a single `status` column covers pending (`suggested`), `rejected`, and the three durable states. The suggest route refuses early when no claims exist or a pending batch remains, takes an in-flight claim on the project, calls F-02's `complete()` with kind `suggest`, validates JSON with zod against the real claim ids, and batch-inserts candidates. Accept, reject and set-status are conditional updates, so illegal or racing transitions touch zero rows. Pure logic sits in a Node-importable module for fixture tests.

## Phases at a Glance

| Phase                 | What it delivers                                                 | Key risk                                               |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| 1. Schema and types   | Migration, RLS, `src/types.ts`, SQL assertions                   | Must sort after S-02's migration and reuse its helper  |
| 2. Suggestion service | Prompt, zod parser, guarded orchestration, fixture tests         | Model output quality and hallucinated claim references |
| 3. API routes         | Suggest, review (accept/edit/reject), lifecycle status routes    | Race and illegal-transition handling                   |
| 4. UI                 | `/assumptions` page with pending cards, durable list, entry link | Keeping copy honest ("risky guess", never "validated") |

**Prerequisites:** S-02 (projects, claims) and F-02 (`complete()`) implemented first, plus F-01 beneath them; local Supabase via Docker; a real `OPENROUTER_API_KEY` for manual runs.
**Estimated effort:** ~2-3 sessions across 4 phases.

## Open Risks & Assumptions

- All three prerequisites are plan-only, so any change to their contracts (helper names, `AIResult`, column names) must be reflected here.
- "All claims count" means unreviewed AI-drafted claims feed suggestions; accepted as a deliberate tradeoff, revisit if founders anchor on AI framing.
- One batch of 5-8 in a single synchronous call (up to ~31s worst case with retry) may feel slow on Workers; fallbacks are a smaller `max_tokens` or a faster model.
- Founders cannot edit an assumption after accepting it; if that proves annoying in beta it is a small follow-up.

## Success Criteria (Summary)

- A founder can go from a drafted canvas to a reviewed set of durable, status-tracked assumptions in one sitting.
- Nothing becomes durable without an explicit founder action, and no AI output or page copy implies validation.
- Users are isolated by RLS, and failures leave no half-written batches.
