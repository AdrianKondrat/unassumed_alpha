# Rehearsal Scorecard (S-06) — Plan Brief

> Full plan: `context/changes/rehearsal-scorecard/plan.md`
> Research: `context/changes/rehearsal-scorecard/research.md`

## What & Why

When a rehearsal session ends, the founder automatically gets a scorecard that flags leading, hypothetical, solution-biased, past-behavior and specificity problems in their questions, quotes each flagged turn exactly, and gives at least one concrete rewrite. This is the north-star slice: the moment the product proves founders can improve their interview questions through AI-scored rehearsal, without ever judging the idea itself.

## Starting Point

Only the starter exists (auth, middleware). F-02's AI call path, S-05's session/turn tables and any rehearsal schema are plan-only or stubs. The roadmap's blocking Unknown (can scoring meet ≤30s on Workers?) is answered by research: yes, synchronously, on the Paid plan.

## Desired End State

Ending a session returns a scorecard within ~30s, or a saved failed state with a Retry button. Zero founder turns shows "not enough transcript" with no AI call. Every scorecard carries the beta disclaimer and never uses "validated"/"proven" language.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Execution model | Sync, one batched LLM call in the end-session request | Fits Workers limits and 30s NFR with no new infra | Research + Plan |
| Failure UX | Persisted `failed` scorecard + Retry | Founders have ~5 rehearsals/month; a failure must not lose one | Plan |
| Data model | `scorecards` + `scorecard_flags` tables | Queryable for later trends, RLS per table | Plan |
| Quote integrity | Model returns positions; server fills quotes, validates, rejects banned words | Exact quotes by construction; enforces hard product boundary | Plan |
| 30s budget | ~12s per call, 25s shared deadline, F-02 `complete()` gets timeout/retry overrides | F-02 default (25s + retry) can reach ~50s | Research + Plan |
| Unbuilt prerequisites | Plan against documented contracts; reconcile S-05 names later | Unblocks planning without owning S-05 | Plan |

## Scope

**In scope:** scoring module, schema + RLS, scoring service + endpoints, scorecard UI, live latency/wording verification.

**Out of scope:** Workflows/queues, per-turn parallel scoring, trends, benchmarking, S-05 session/turn tables, resume (S-07), rate limiting.

## Architecture / Approach

Pure `src/lib/scorecard.ts` (prompt, zod schema, parser, banned-word check) → migration for two tables → `scorecard-service.ts` calling F-02's `complete({taskKind:"score"})` under a shared deadline → POST endpoint called on session end and for retry → Astro page + React island.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Scoring core | Prompt, schema, parser, tests | Prompt quality / false flags |
| 2. Schema and RLS | Tables, policies, SQL tests | S-05 table names not final |
| 3. Service and API | Deadline-bound scoring, retry, idempotency | Extending F-02's `complete()` |
| 4. Scorecard UI | Page with flags, quotes, disclaimer, retry | Mobile layout of long quotes |
| 5. Verification | p95 latency + wording check on real model | Model latency over budget |

**Prerequisites:** F-02 implemented, S-05 sessions/turns available, Workers Paid plan.
**Estimated effort:** ~4-5 sessions across 5 phases.

## Open Risks & Assumptions

- S-05 table/column names are assumed (`rehearsal_sessions`, `rehearsal_turns`) and need reconciliation.
- Real model latency is unmeasured; Phase 5 may force a faster model or a rethink.
- Scoring accuracy is the hardest quality problem; the beta disclaimer is the agreed mitigation.

## Success Criteria (Summary)

- A founder ending a session sees a scorecard with quoted flags, a rewrite and the disclaimer within ~30s.
- Failures are recoverable and no scorecard ever implies the idea is validated.
