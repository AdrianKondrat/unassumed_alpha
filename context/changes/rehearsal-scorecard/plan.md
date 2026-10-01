# Rehearsal Scorecard (S-06) Implementation Plan

## Overview

When a rehearsal session ends, the founder automatically gets a scorecard that flags question-quality problems (leading, hypothetical, solution-biased, past-behavior, specificity), quotes each flagged turn exactly, offers at least one concrete rewrite, and shows a "beta scoring" disclaimer. Scoring is one synchronous batched LLM call inside the end-session request, validated server-side, persisted as `scorecards` + `scorecard_flags`, with a persisted failed state and Retry for failures. The scorecard never states or implies the idea is "validated".

## Current State Analysis

- Only the starter exists: auth routes, middleware, `src/lib/supabase.ts`. No `src/lib/ai.ts`, no migrations, no rehearsal tables, no OpenRouter key (research.md "Implemented vs planned").
- F-02 (`context/changes/ai-provider-integration/plan.md`) documents `complete({ taskKind, messages, supabase, founderId, overrideModel? })` returning a typed `AIResult`; `score` timeout 25s with one retry after ~500ms (:159-205). Worst case ~50s breaks the 30s NFR.
- S-05 (sessions/turns/persona) is a stub; its tables are not designed. This plan assumes a shape and flags it for reconciliation.
- Deployment is a Worker (`wrangler.jsonc:3-11`), not Pages. Synchronous scoring fits Workers limits on the Paid plan: outbound fetch wait is not CPU time and HTTP requests have no hard wall-clock cap while the client is connected.

## Desired End State

Ending a session (manually or at the turn cap) returns a scorecard within ~30s, or a persisted `failed` scorecard the founder can retry. The scorecard page shows per-flag label, turn position, exact quoted founder text, explanation, at least one rewrite, and the disclaimer. A session with zero founder turns shows "not enough transcript" and makes no AI call. Verify by running a rehearsal with deliberately leading questions and confirming flags and quotes, plus a latency run at 10 turns.

### Key Discoveries:

- Quotes are exact by construction if the server fills quote text from stored turns and the model returns only turn positions.
- S-02 already established the pattern: dependency-free module, zod schema, fence-stripping parser, banned-word rejection, tested via `node --experimental-strip-types` (`context/changes/ai-drafted-canvas-from-brief/plan.md:128-148`).
- F-02's `complete()` is the only path that sets `provider.data_collection: "deny"` and records usage; scoring must go through it.
- Workers allow ~6 concurrent outbound connections per request, so a single batched call avoids fan-out limits.

## What We're NOT Doing

- No Workflow, Queue, Durable Object or custom worker entrypoint.
- No per-turn parallel scoring and no async/polling flow.
- No trend / before-after view across rehearsals (secondary criterion, later slice).
- No cross-founder benchmarking, no numeric "viability" score of any kind.
- No session/turn/persona tables or turn exchange (S-05), no resume handling (S-07).
- No rate limiting or cost guard beyond the turn cap.

## Implementation Approach

Build bottom-up: a pure scoring module (testable without Astro), then schema, then a service + API that orchestrates one batched `complete()` call under a shared deadline, then the UI, then real-model verification. The batched call returns a JSON array keyed by turn position; the server validates, joins to stored turns for quotes, and writes the scorecard in one transaction-like sequence.

## Prerequisites and assumptions (hard)

- F-02 is implemented (`src/lib/ai.ts`, `ai_usage_events`, OpenRouter key). This plan requires one extension to it: an optional per-call `timeoutMs` override and a `retry` option on `complete()` (Phase 3).
- S-05 provides, per session: an `ended` status, `founder_id`/workspace linkage, and ordered founder turns with a position and text. Assumed names: `rehearsal_sessions(id, ... status)` and `rehearsal_turns(session_id, position, role, content)`. Reconcile column names when S-05 is planned; only Phases 2-3 reference them.
- The Cloudflare Worker is on the Paid plan (Free's 10 ms CPU limit is not viable for this route).

## Critical Implementation Details

- **Deadline:** one overall deadline of ~25s starts when scoring begins. The batched call gets a ~12s timeout; retry once only if time remains, otherwise mark `failed`. This keeps result-or-clean-failure inside the 30s NFR.
- **Idempotency:** a unique key on `scorecards(session_id)` plus a `scoring_started_at` lease (stale after ~60s, as in S-02's `draft_started_at`) prevents double scoring from double-clicks or retries racing.

## Phase 1: Scoring core (pure module)

### Overview

A dependency-free module that builds the scoring prompt, parses and validates model output, and attaches exact quotes.

### Changes Required:

#### 1. Scoring module

**File**: `src/lib/scorecard.ts` (relative imports only, no `astro:*` or `@/`)

**Intent**: Build messages for one batched classification over founder turns, parse the raw model text, validate it, and produce flags whose quotes come from the stored turns.

**Contract**: exports `buildScoreMessages(turns)`, `ScoreSchema` (zod: `flags[]` of `{ position, label, explanation }`, `rewrites[]` of `{ position, suggestion }`, `summary`), `parseScore(raw, turns)` returning `{ ok: true, scorecard } | { ok: false, reason }`. Labels are the fixed set leading, hypothetical, solution_biased, past_behavior, specificity. `parseScore` rejects: unknown labels, positions not in `turns`, zero rewrites, and any text (summary, explanations, rewrites) containing "validated", "proven" or equivalent, case-insensitive. Quote text is taken from `turns`, never from the model. The prompt instructs the model to judge question quality only, never the idea.

#### 2. Test script

**File**: `scripts/test-scorecard.mjs`, plus `test:scorecard` in `package.json`

**Intent**: Step-list tests like the S-02 script: valid output, fenced JSON, bad label, bad position, banned words, zero rewrites, quote taken from stored turn.

**Contract**: run with `node --experimental-strip-types scripts/test-scorecard.mjs`. `zod` is added to dependencies if F-02/S-02 have not already added it.

### Success Criteria:

#### Automated Verification:

- Scorecard unit tests pass: `npm run test:scorecard`
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`

#### Manual Verification:

- Reading the prompt confirms it never asks the model to judge the idea or business viability

---

## Phase 2: Schema and RLS

### Overview

Persist scorecards and flags with per-operation RLS.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/<timestamp>_scorecards.sql` (generate with `npx supabase migration new`)

**Intent**: Create `scorecards` and `scorecard_flags` with RLS enabled and granular policies.

**Contract**: `scorecards(id, session_id unique references rehearsal_sessions, status check in ('pending','ready','failed','insufficient'), summary, scoring_started_at, model, error_kind, created_at)`. `scorecard_flags(id, scorecard_id, position, label check in the five labels, quote, explanation, rewrite null)`. Policies for `authenticated` only: SELECT where the owning session belongs to the caller (via the S-05/F-01 membership helper); no client INSERT/UPDATE/DELETE (server-written). `search_path` pinned on any helper. No anon access.

#### 2. SQL tests

**File**: `supabase/tests/scorecards.sql`

**Intent**: Prove isolation and constraints, rolled back in one transaction.

**Contract**: impersonate two founders via `set local role authenticated` + `request.jwt.claims`; assert cross-founder SELECT returns nothing, client writes fail, duplicate scorecard per session fails, invalid label fails.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase db reset`
- SQL tests pass: `psql ... -v ON_ERROR_STOP=1 -f supabase/tests/scorecards.sql`

#### Manual Verification:

- RLS policies reviewed: no anon access, no client write policies

---

## Phase 3: Scoring service and API

### Overview

Orchestrate scoring under the deadline and expose end-session and retry endpoints.

### Changes Required:

#### 1. Extend F-02 `complete()`

**File**: `src/lib/ai.ts`

**Intent**: Let callers override the per-call timeout and disable the built-in retry so the scoring service owns the deadline.

**Contract**: add optional `timeoutMs?: number` and `retry?: boolean` (default true) to the `complete()` input; existing behavior unchanged when omitted; extend the F-02 test script accordingly.

#### 2. Scoring service

**File**: `src/lib/services/scorecard-service.ts`

**Intent**: Given a session, load founder turns, short-circuit the zero-turn case, claim the scoring lease, call `complete({ taskKind: "score", timeoutMs ~12000, retry: false })`, parse via `parseScore`, retry once only if the shared 25s deadline allows, then persist `ready` or `failed`.

**Contract**: `scoreSession(supabase, founderId, sessionId)` returns a domain code: `ready | insufficient | failed | already_scoring`. Zero founder turns writes `insufficient` with no AI call. Provider errors map to `error_kind` (`timeout`, `ai_failed`, `invalid_output`). Never logs prompts, transcripts or persona details.

#### 2b. Endpoints

**Files**: `src/pages/api/rehearsal/[sessionId]/score.ts` (POST: score or retry), invoked also from the S-05 end-session path

**Intent**: Authenticated, zod-validated, `prerender = false`; re-scoring is allowed only for `failed` scorecards.

**Contract**: POST returns `{ status }` plus scorecard payload for `ready`; response bodies never include persona scenario details. The S-05 end-session handler (manual end and turn cap) calls `scoreSession` after marking the session ended; wiring is a small edit coordinated with S-05.

### Success Criteria:

#### Automated Verification:

- Service tests (with a stubbed `complete`) cover ready, insufficient, invalid_output, timeout, deadline exhaustion, already_scoring: `npm run test:scorecard`
- Type checking and lint pass: `npx astro check && npm run lint`

#### Manual Verification:

- Ending a session with a stubbed model produces a ready scorecard
- Double-clicking Retry does not create duplicate rows or duplicate AI calls

---

## Phase 4: Scorecard UI

### Overview

Show the scorecard, the insufficient state and the failed/retry state.

### Changes Required:

#### 1. Scorecard page and island

**Files**: `src/pages/rehearsal/[sessionId]/scorecard.astro`, `src/components/rehearsal/Scorecard.tsx`

**Intent**: Server-render the scorecard for the owning founder; the React island handles the Retry action and loading state while scoring is in progress.

**Contract**: shows each flag with label, turn position, exact quoted text, explanation; at least one rewrite; a visible "beta scoring" disclaimer that scoring is early-stage and may miss nuance; "not enough transcript" for `insufficient`; clear failure message plus Retry for `failed`. Copy must not use "validated", "proven" or viability language. SSR props contain only scorecard data, never persona scenario fields.

### Success Criteria:

#### Automated Verification:

- Build passes: `npm run build`
- Lint passes: `npm run lint`
- Smoke test still passes: `npm run smoke`

#### Manual Verification:

- Scorecard renders correctly on desktop and mobile, including long quotes
- Disclaimer is visible without scrolling past the first flag
- Retry works and shows progress

---

## Phase 5: Latency and wording verification

### Overview

Prove the 30s NFR and the wording guardrail against the real model.

### Changes Required:

#### 1. Verification script and notes

**File**: `scripts/verify-scorecard-live.mjs` (manual, not run in CI), results recorded in this change folder

**Intent**: Score a synthetic 10-turn transcript against the real OpenRouter model several times, recording end-to-end latency and checking outputs for banned words and quote integrity.

**Contract**: reports p50/p95 latency and violation count; target p95 under 25s. If the target is missed, record it and decide between a faster model (via `TASK_CONFIG`) or revisiting async execution before shipping.

### Success Criteria:

#### Automated Verification:

- Live verification script exits 0 with p95 < 25s and zero banned-word violations: `node scripts/verify-scorecard-live.mjs`

#### Manual Verification:

- A transcript of deliberately leading questions gets sensible flags; a good transcript gets few or none
- The beta disclaimer and rewrite appear in every ready scorecard

---

## Testing Strategy

### Unit Tests:

- `parseScore`: valid, fenced, bad label, bad position, banned words, missing rewrite, quote from stored turn
- Service: all domain outcomes with stubbed `complete`

### Integration Tests:

- SQL RLS tests; end-session to scorecard flow against local Supabase with a stubbed provider

### Manual Testing Steps:

1. Rehearse 3 leading questions, end early, confirm flags and quotes
2. End a session with zero founder turns, confirm "not enough transcript" and no usage row
3. Force a provider failure, confirm failed state and Retry

## Performance Considerations

One subrequest per scoring attempt; input bounded by the 8-10 turn cap. Overall deadline 25s, per-call 12s. Run on the Workers Paid plan.

## Migration Notes

No existing data. Column names referencing S-05 tables need reconciliation when S-05 is planned.

## References

- Related research: `context/changes/rehearsal-scorecard/research.md`
- F-02 call path: `context/changes/ai-provider-integration/plan.md:150-237`
- Parse/validate pattern: `context/changes/ai-drafted-canvas-from-brief/plan.md:128-148`
- PRD: `context/foundation/prd.md:59-70` (US-01), FR-015/016

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Scoring core (pure module)

#### Automated

- [ ] 1.1 Scorecard unit tests pass: `npm run test:scorecard`
- [ ] 1.2 Type checking passes: `npx astro check`
- [ ] 1.3 Linting passes: `npm run lint`

#### Manual

- [ ] 1.4 Prompt reviewed: never asks the model to judge the idea or viability

### Phase 2: Schema and RLS

#### Automated

- [ ] 2.1 Migration applies cleanly: `npx supabase db reset`
- [ ] 2.2 SQL tests pass: `psql ... -v ON_ERROR_STOP=1 -f supabase/tests/scorecards.sql`

#### Manual

- [ ] 2.3 RLS policies reviewed: no anon access, no client write policies

### Phase 3: Scoring service and API

#### Automated

- [ ] 3.1 Service tests cover ready, insufficient, invalid_output, timeout, deadline exhaustion, already_scoring
- [ ] 3.2 Type checking and lint pass: `npx astro check && npm run lint`

#### Manual

- [ ] 3.3 Ending a session with a stubbed model produces a ready scorecard
- [ ] 3.4 Double-clicking Retry does not create duplicate rows or AI calls

### Phase 4: Scorecard UI

#### Automated

- [ ] 4.1 Build passes: `npm run build`
- [ ] 4.2 Lint passes: `npm run lint`
- [ ] 4.3 Smoke test passes: `npm run smoke`

#### Manual

- [ ] 4.4 Scorecard renders correctly on desktop and mobile, including long quotes
- [ ] 4.5 Disclaimer is visible without scrolling past the first flag
- [ ] 4.6 Retry works and shows progress

### Phase 5: Latency and wording verification

#### Automated

- [ ] 5.1 Live verification script exits 0 with p95 < 25s and zero banned-word violations

#### Manual

- [ ] 5.2 Leading-question transcript gets sensible flags; a good transcript gets few or none
- [ ] 5.3 Beta disclaimer and rewrite appear in every ready scorecard
