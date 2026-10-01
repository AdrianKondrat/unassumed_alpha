# Rehearsal Scorecard (S-06) Implementation Plan

> **IMPLEMENTED on `mvp` (updated 2026-10-01, session 3).** Phases 1-4 are built and verified; Phase 5 (live latency and wording check against the real model) cannot run in the build sandbox and is left for the user (see "Implementation notes"). Some decisions deviate from the plan below, notably that scoring is triggered by the scorecard page, not the end-session request.

> **RECONCILE BEFORE IMPLEMENTING (written 2026-10-01).** (1) Real S-05 columns (see its plan): `rehearsal_sessions(id, project_id, assumption_id, status in ('active','ended'), ended_reason in ('user','cap'), created_at, ended_at)` and `rehearsal_turns(session_id, seq 1..8, question, reply, …)`: a founder turn is the `question` of each row and its position is `seq`; there is no `role`/`content`/`position` and no per-session `founder_id` (ownership is via project → workspace). Replace the plan's assumed names. Persona replies are never scored. (2) Writes to sessions/turns/scorecards are service-role only (S-05's `src/lib/supabase-admin.ts`); scorecards follow the same "no client write policies" rule. (3) The `complete()` extension this plan asks for (`timeoutMs`, `retry`) **already exists** from F-02; skip that step. Also use `jsonMode: true`. (4) Wire scoring into S-05's end-session path (manual end and cap auto-end) as the plan says. (5) The Workers Paid plan requirement still needs the founder's confirmation.

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

- [x] 1.1 Scorecard unit tests pass: `npm run test:scorecard`
- [x] 1.2 Type checking passes: `npx astro check`
- [x] 1.3 Linting passes: `npm run lint`

#### Manual

- [x] 1.4 Prompt reviewed: never asks the model to judge the idea or viability (read; real-model behaviour unverified)

### Phase 2: Schema and RLS

#### Automated

- [x] 2.1 Migration applies cleanly: `npx supabase db reset` (applied with `stack.sh reset`)
- [x] 2.2 SQL tests pass: `psql ... -v ON_ERROR_STOP=1 -f supabase/tests/scorecards.sql`

#### Manual

- [x] 2.3 RLS policies reviewed: no anon access, no client write policies (asserted in SQL, mutation-checked)

### Phase 3: Scoring service and API

#### Automated

- [x] 3.1 Service tests cover ready, insufficient, invalid_output, timeout, deadline exhaustion, already_scoring (attempt loop in `scorecard-run.ts` tested with a stubbed model and clock; insufficient and in_progress are DB-function outcomes asserted in SQL and will be asserted end-to-end in smoke)
- [x] 3.2 Type checking and lint pass: `npx astro check && npm run lint`

#### Manual

- [x] 3.3 Ending a session with a stubbed model produces a ready scorecard (scoring is page-triggered: smoke ends a session, then scoring it against the fake provider yields `ready`)
- [x] 3.4 Double-clicking Retry does not create duplicate rows or AI calls (smoke: two parallel `/score` calls cost exactly one AI call; the browser run showed one request per click)

### Phase 4: Scorecard UI

#### Automated

- [x] 4.1 Build passes: `npm run build`
- [x] 4.2 Lint passes: `npm run lint`
- [x] 4.3 Smoke test passes: `npm run smoke` (102 steps)

#### Manual

- [x] 4.4 Scorecard renders correctly on desktop and mobile, including long quotes (Chromium at 1280 and 390 px, no horizontal scroll)
- [x] 4.5 Disclaimer is visible without scrolling past the first flag (rendered before the summary; at y=448 of 844 px on a phone)
- [x] 4.6 Retry works and shows progress (browser run: auto-start sends one request, a failure is not auto-retried, Try again recovers, a second visitor polls to the finished card)

### Phase 5: Latency and wording verification

#### Automated

- [ ] 5.1 Live verification script exits 0 with p95 < 25s and zero banned-word violations

#### Manual

- [ ] 5.2 Leading-question transcript gets sensible flags; a good transcript gets few or none
- [ ] 5.3 Beta disclaimer and rewrite appear in every ready scorecard

### Implementation notes (phases 1-4 done; 5 needs the real model)

- **Built and verified so far (commit "S-06 part 1")**: `src/lib/services/scorecard.ts` (labels, prompt, zod schema, `parseScore`), `scorecard-run.ts` (attempt loop with injected model and clock), `scorecard-service.ts` (`scoreSession`), `scorecards.ts` (RLS reads), route `POST /api/rehearsal/sessions/[id]/score`, migration `20261001100500_scorecards.sql`, `supabase/tests/scorecards.sql`, `scripts/test-scorecard.mjs` (24 checks, `npm run test:scorecard`, CI step added), types in `src/types.ts`, `not_ended` -> 409 in `rehearsal-http.ts`. Lint, `astro check`, all offline tests, all SQL tests, build and the existing 93 smoke steps pass. The offline module/loop (25 mutations) and the SQL (31 mutations) were mutation-checked; nothing at HTTP or UI level exists yet for scoring.
- **Deviation: scoring is not run inside the end-session request.** The scorecard page `/rehearsal/[id]/scorecard` triggers it (an island POSTs `/score` on arrival when there is no scorecard, polls on `in_progress`, shows Retry on `failed`). Reasons: ending a session stays instant, the cap-ending 8th reply request does not also wait for scoring, expired sessions (S-07) and sessions ended in another tab are scored the same way, and no AI is spent unless the founder is present.
- **Deviation: no numeric score.** The scorecard shows derived counts (`turns_flagged` of `turns_scored`) and prose; nothing resembling a viability score.
- **Labels are problems found** (leading, hypothetical, solution_biased, past_behavior = "not about the past", specificity = "too vague"); display names are in `LABEL_META`.
- **Quotes are exact twice over**: `parseScore` takes them from the stored turns and `store_scorecard` copies `question` into `quote`/`original` in SQL (the model's text for them is ignored). The viability-wording screen applies only to model-written prose, never to a founder's quoted words. A rewrite that is itself hypothetical or repeats the question fails the attempt.
- **Lease and state machine** (DB functions, service-role only, execute grants asserted): `claim_scorecard(session)` -> `not_found | not_ended | ready | insufficient | in_progress | claimed` (60 s stale lease, row-locked); `store_scorecard(...)` stores only a claimed attempt, replaces flags/rewrites atomically and requires >= 1 rewrite for `ready`. A failed scorecard can be re-claimed (Retry). Zero turns -> `insufficient`, no AI call.
- **Budget**: 12 s per attempt, shared 25 s deadline, a second attempt only with >= 6 s left (`scorecard-run.ts`), `complete({ taskKind: "score", jsonMode: true, timeoutMs, retry: false })`.
- **Phase 4 (UI, part 2)**: `src/pages/rehearsal/[id]/scorecard.astro` (RLS reads; redirects to `/rehearsal` when the session is not the founder's and to `/rehearsal/[id]` while it is still active; ready / insufficient render on the server, everything else shows the island), `ScorecardStatus.tsx` + `useScorecardRun.ts`, `SCORE_FAILURE_COPY` moved into `scorecard.ts` so the API and the page share one wording. Links: "See your scorecard" in the ended chat panel (also the ended `/rehearsal/[id]` page) and "View scorecard" per past session on `/rehearsal`.
- **Verification**: fake-provider `score` handler (flags "would you" as hypothetical and "don't you think" / "wouldn't" as leading; always one past-behaviour rewrite; modes `viability`, `garbage`, `http500`, `short` and `unknown_claim` fail the attempt; records `turnsSent` only). 9 new smoke steps (102 total) incl. the real-PostgREST check that a founder's token can read but not write scorecards, flags, rewrites or call the two functions. Nine app-level mutations were each caught by the intended step: active session served, ownership check removed, viability wording unscreened, empty session reaching the AI, wrong unflagged count, missing links (past list, chat), unknown positions skipped instead of failing, weakened disclaimer. A Chromium script (throwaway, scratchpad) checked the island's auto-start, no auto-retry after failure, Try again, polling on `in_progress`, and 390/1280 px layout.
- **Still to do (user, needs a machine that can reach openrouter.ai)**: Phase 5. Run a leading-question transcript and a good transcript through the real model and judge the flags; measure latency against the 25 s deadline; confirm no banned wording; the `gpt-4o-mini` slug in `TASK_CONFIG` is unconfirmed.