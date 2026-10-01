# AI-Drafted Canvas from Brief — Plan Brief

> Full plan: `context/changes/ai-drafted-canvas-from-brief/plan.md`

## What & Why

A founder creates their one project from a short rough-notes brief and gets an AI-drafted Business Model Canvas. Every AI-authored claim is stored and shown as "AI draft", distinct from founder-authored ones. This is roadmap slice S-02 (FR-005, FR-006): the first step of Scribble, and it must read as a starting point to challenge, not authority.

## Starting Point

No domain schema, types or project UI exist. The app has auth pages and a static dashboard. The workspace schema (F-01) and the AI call path `complete()` (F-02) are planned but not built, and S-01 is a stub; this plan targets their documented contracts.

## Desired End State

A signed-in founder submits a brief at `/project/new`, lands on `/project`, and sees 9 BMC blocks of badged AI claims. Failed drafts show a message and Retry without losing the brief. A second project or a second draft is refused cleanly.

## Key Decisions Made

| Decision           | Choice                                                       | Why                                                | Source |
| ------------------ | ------------------------------------------------------------ | -------------------------------------------------- | ------ |
| Claim storage      | `projects` + `canvas_claims` rows                            | S-03 conflicts and S-04 acceptance work per claim  | Plan   |
| AI marking         | Persisted `origin`; badge; flips to `founder` on edit (S-03) | Honest, queryable, matches shape-notes `ai_draft`  | Plan   |
| AI output          | JSON validated by zod, strict                                | Never store malformed or viability-claiming output | Plan   |
| Flow               | Create project first, draft in a separate retryable call     | Brief is never lost on AI failure                  | Plan   |
| Failure / redraft  | Retry button; drafting only while canvas is empty            | No destructive path in this slice                  | Plan   |
| Project cap        | DB unique on `workspace_id` + friendly error                 | Race-proof invariant                               | Plan   |
| Testing            | SQL RLS script + Node fixture script                         | Matches repo conventions, no new runner            | Plan   |
| Double-draft guard | Conditional-update lock (`draft_started_at`, 60s stale)      | Prevents duplicate drafts without a queue          | Plan   |

## Scope

**In scope:** schema + RLS, draft service, two API routes, brief form, canvas view with AI badge, dashboard link, tests.

**Out of scope:** claim editing and conflicts (S-03), assumptions (S-04), regenerate, deletion, multi-project, email verification (S-01), background jobs.

## Architecture / Approach

Persist first, draft second. Pure prompt/schema/parser module (Node-testable) feeds a thin orchestration that calls F-02's `complete()` with kind `draft`, validates, and batch-inserts claims. The database enforces the cap and vocabularies; routes map violations to friendly messages.

## Phases at a Glance

| Phase               | What it delivers                                 | Key risk                                            |
| ------------------- | ------------------------------------------------ | --------------------------------------------------- |
| 1. Schema and types | Tables, RLS, types, SQL test                     | RLS correctness; depends on F-01's helper           |
| 2. Draft service    | Prompt, zod parser, orchestration, fixture tests | Model output drift; Node-importable module boundary |
| 3. API routes       | Create-project and draft routes, middleware      | Draft race and failure cleanup                      |
| 4. UI               | Brief form, badged canvas, retry, dashboard link | Badge clarity and accessibility                     |

**Prerequisites:** F-01 and F-02 implemented (S-01 recommended for verified accounts).
**Estimated effort:** ~3-4 sessions across 4 phases.

## Open Risks & Assumptions

- F-01/F-02 are unbuilt; if their contracts change, Phases 1-2 need adjusting.
- Draft latency (15s timeout, one retry, worst case about 31s) may be tight on Workers; measure with a real model.
- Model may produce generic or off-schema canvases; strict parsing trades visible failures for data quality.

## Success Criteria (Summary)

- Brief to badged 9-block canvas works end to end, in one sitting.
- AI claims are always distinguishable from founder claims, in data and in UI.
- No lost brief, no duplicate drafts, no second project.
