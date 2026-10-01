# Assumption Suggestion and Lifecycle Implementation Plan

## Overview

A founder requests one batch of 5-8 AI-suggested assumptions derived from their canvas claims, then accepts (optionally editing first) or rejects each one. Accepted assumptions become durable and carry a lifecycle status (`active`, `superseded`, `retired`) the founder can set by hand. This is slice S-04 in `context/foundation/roadmap.md` (PRD FR-009, FR-010, FR-011). The AI proposes candidates only; nothing is durable until the founder acts, which is what keeps "name the risky guess" a human step.

## Current State Analysis

- No domain schema exists in the repo: `supabase/` has only `config.toml`; no `migrations/`, no `src/types.ts`, no `src/lib/ai.ts`.
- All prerequisites are **planned but not implemented**, so this plan builds on their planned contracts:
  - F-01 (`context/changes/data-workspace-scaffold/plan.md`): `workspaces`, `workspace_members`, `is_workspace_member(ws uuid)`, the signup trigger.
  - F-02 (`context/changes/ai-provider-integration/plan.md`): `complete({ taskKind, messages, supabase, founderId })` in `src/lib/ai.ts` returning `AIResult`; task kind `suggest` already reserved (15s timeout, one retry, `ai_usage_events` row per success). It returns raw assistant text only; parsing and validation belong to the consuming slice.
  - S-02 (`context/changes/ai-drafted-canvas-from-brief/plan.md`): `projects` (one per workspace, with `draft_started_at`) and `canvas_claims` (9-block vocabulary, `origin`, no DELETE policy), the pure-module + fixture-test pattern, and the `is_project_member` helper option.
- S-02 has no "accepted claim" concept; claims carry only `origin` (`ai_draft` / `founder`). FR-009's "accepted canvas claims" is resolved below as "all existing claims".
- App surface: auth pages, static `/dashboard`, `src/middleware.ts` with `PROTECTED_ROUTES` prefix list, plain form-POST API routes that redirect with `?error=` (`src/pages/api/auth/signup.ts`), one shadcn primitive.
- `zod` is mandated by CLAUDE.md; S-02's plan adds it to `package.json`. If S-02 has not landed, this slice adds it.
- No test runner; convention is zero-dependency Node scripts (`scripts/smoke.mjs`) and rolled-back SQL assertion scripts.

## Desired End State

A signed-in founder whose project has a drafted canvas can:

1. Open `/assumptions` and press "Suggest assumptions" to get 5-8 pending candidates, each showing its statement, a risk note, and which canvas claims it came from.
2. Accept, edit-then-accept, or reject each candidate. Accepted ones appear in a durable list with status `active`; rejected ones disappear.
3. Set any durable assumption's status to `active`, `superseded` or `retired`, in any direction.
4. Reload at any time and see the same state; request a new batch only after the pending batch is fully resolved.
5. See a recoverable message with Retry if suggestion fails; no pending rows are left half-written.

Verification: `npm run test:assumptions` and the SQL assertion script pass; `npm run lint`, `npx astro check`, `npm run build`, `npm run smoke` stay green; a manual end-to-end run on local Supabase with a real OpenRouter key works as above.

### Key Discoveries:

- Reuse S-02's single RLS predicate chain: `is_workspace_member()` (F-01) via the project's workspace.
- `complete()` returns raw text, so a zod parser plus forbidden-wording check live in this slice (same shape as S-02's `parseDraft`).
- S-02's draft-race protocol (conditional update on a timestamp column, 60s staleness window, reset on failure) transfers directly to suggestion via `projects.suggest_started_at`.
- `canvas_claims` rows are never deleted in this release, so `assumption_claims` links stay valid and need no cascade logic beyond the assumption side.
- Node 22.14 cannot import `.ts` without `--experimental-strip-types`, and `@/` aliases do not resolve in plain Node, so the pure module must use relative imports only.

## What We're NOT Doing

- No founder-authored (from scratch) assumptions; every assumption originates as an AI suggestion (FR-009/FR-010 define no manual-create flow).
- No editing of an assumption after it is accepted; editing happens at review time only.
- No hard delete of assumptions and no DELETE policy; rejection is a status.
- No per-block or free-form-prompt suggestion, no hard per-project suggestion cap, no usage counters.
- No confirm/accept step on canvas claims (S-02/S-03 territory) and no dependency on S-03.
- No evidence, decisions, supports/contradicts, or replacement links for `superseded` (parked in the roadmap).
- No rehearsal, persona, or assumption-picker UI for S-05 (this slice only guarantees `active` assumptions are queryable).
- No HTTP-level smoke extension and no new test framework.

## Implementation Approach

Persist first, then act. One new `assumptions` table holds both pending candidates and durable assumptions, distinguished by a single `status` column (`suggested`, `rejected`, `active`, `superseded`, `retired`). A small `assumption_claims` table records provenance. The suggest route takes a lightweight in-flight claim on the project, calls `complete()` with kind `suggest`, validates the JSON with zod against the set of real claim ids, and inserts all candidates in one batch as `suggested`. Accept, reject and set-status are conditional updates (`where id = ? and status in (...) returning row`) so illegal or racing transitions affect zero rows and map to a friendly message. The database enforces vocabulary and ownership; the app enforces the transition rules. Pure logic lives in a dependency-free module testable with plain Node.

## Critical Implementation Details

- **"Pending batch must be resolved" rule.** The suggest action refuses (without error noise) if any `suggested` row exists for the project, and if the project has zero claims it returns a "draft your canvas first" outcome. Both checks run before the AI call so no spend occurs.
- **In-flight guard.** Add `projects.suggest_started_at timestamptz`. The suggest route first runs a conditional update (`suggest_started_at is null or suggest_started_at < now() - interval '60 seconds'`, returning the row) and proceeds only if it gets a row. On AI or validation failure, reset it to null; on success, reset it after the batch insert. Same 60s staleness recovery as S-02.
- **Pure module must be Node-importable.** `src/lib/services/assumption-suggest.ts` imports nothing from `astro:*` or `@/`; relative imports only. Route-side orchestration lives in a separate file.
- **Parser validates provenance.** `parseSuggestions(raw, validClaimIds)` fails if any referenced claim id is not in the set that was sent to the model, so a hallucinated reference counts as an invalid output rather than a dangling link.
- **Honesty wording.** The prompt frames assumptions as risky guesses to test, never as facts or findings, and forbids "validated" / "proven" wording (PRD guardrail). The parser rejects output containing those words (case-insensitive) on both `statement` and `risk_note`.
- **Repeat avoidance.** Pass up to the last 20 `rejected` statements into the prompt as "do not suggest these or near-duplicates". The same list is not used to filter output in code.

## Phase 1: Schema and shared types

### Overview

Introduce assumption storage with RLS, enforce vocabulary and limits in the database, and add shared types.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/<timestamp>_assumptions.sql` (generate timestamp at implementation time, `YYYYMMDDHHmmss`; must sort after S-02's migration)

**Intent**: Create `assumptions` and `assumption_claims`, add the in-flight column to `projects`, and add per-operation `authenticated` RLS in one migration so the slice's data contract lands or fails together.

**Contract**:

- `alter table public.projects add column suggest_started_at timestamptz`.
- `public.assumptions(id uuid pk default gen_random_uuid(), project_id uuid not null references projects on delete cascade, statement text not null check (char_length(statement) between 1 and 280), risk_note text check (risk_note is null or char_length(risk_note) between 1 and 280), status text not null default 'suggested' check (status in ('suggested','rejected','active','superseded','retired')), origin text not null default 'ai_suggested' check (origin in ('ai_suggested')), edited boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`. `origin` is kept as a single-value check so a future founder-authored origin is a one-line migration. Index on `(project_id, status)`.
- `public.assumption_claims(assumption_id uuid not null references assumptions on delete cascade, claim_id uuid not null references canvas_claims on delete cascade, primary key (assumption_id, claim_id))`.
- RLS enabled on both. `authenticated` only, one policy per operation, gated by membership of the parent project's workspace (reuse S-02's `is_project_member(project uuid)` if it exists, else the equivalent subquery through `projects.workspace_id` and `is_workspace_member`). `assumptions`: SELECT; INSERT with check membership **and** `status = 'suggested'`; UPDATE using + with check membership. `assumption_claims`: SELECT and INSERT gated through the assumption's project. No DELETE policies and no `anon` policies. `updated_at` is set by the app on each update.

#### 2. Shared types

**File**: `src/types.ts`

**Intent**: Add `Assumption`, `AssumptionStatus` (string union of the 5 values) and `AssumptionClaimLink` per CLAUDE.md, plus `DurableAssumptionStatus = "active" | "superseded" | "retired"`. Append if the file exists (F-01/S-02), otherwise create it.

**Contract**: Field names mirror the columns above.

#### 3. SQL assertion script

**File**: `supabase/tests/assumptions.sql`

**Intent**: Prove vocabulary constraints, the insert-as-suggested guard, and cross-user RLS isolation, following the F-01/S-02 test pattern (single transaction, rolled back, `ON_ERROR_STOP`).

**Contract**: With two users, workspaces, projects and claims: an invalid `status` or `origin` is rejected; a client INSERT with `status = 'active'` is rejected; an over-long statement is rejected; user A cannot select, insert, or update user B's assumptions or links; each user sees only their own rows; no DELETE is possible.

### Success Criteria:

#### Automated Verification:

- Migration applies on a fresh DB: `npx supabase db reset`
- No migration lint errors: `npx supabase db lint`
- SQL assertions pass: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/assumptions.sql`
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`

#### Manual Verification:

- Studio shows RLS enabled on both tables with the expected policies.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding to the next phase.

---

## Phase 2: Suggestion service

### Overview

Build and test the pure suggestion logic, then the thin orchestration that applies the guards, calls F-02 and persists the batch.

### Changes Required:

#### 1. Dependency and script

**File**: `package.json`

**Intent**: Ensure `zod` is a dependency (add only if S-02 has not already) and add the fixture-test script.

**Contract**: `"test:assumptions": "node --experimental-strip-types scripts/test-assumption-suggest.mjs"`.

#### 2. Pure suggestion module

**File**: `src/lib/services/assumption-suggest.ts` (new; relative imports only)

**Intent**: Own everything about the suggestion prompt and output shape, independent of Astro and Supabase.

**Contract**: Exports `buildSuggestMessages({ claims: { id, block, text }[], rejectedStatements: string[] })` returning chat messages for `complete()`; a zod `SuggestionsSchema` (array of 5-8 objects `{ statement: string 1-280, risk_note: string 1-280, claim_ids: string[] 1-3 }`, wrapped in an object key such as `suggestions`); and `parseSuggestions(raw: string, validClaimIds: Set<string>)` returning `{ ok: true, suggestions: { statement, riskNote, claimIds }[] } | { ok: false, reason: string }`. Parsing strips optional code fences before `JSON.parse`, fails on schema violations, fails on any `claim_ids` entry outside `validClaimIds`, and fails if any statement or risk note contains "validated" or "proven" (case-insensitive). It also exports the pure transition helpers `canReview(status)` (`status === "suggested"`) and `canSetLifecycle(status)` (status in the three durable values), used by the routes and tests.

#### 3. Orchestration

**File**: `src/lib/services/assumption-suggest-service.ts` (new)

**Intent**: Apply the guards, take the in-flight claim, call `complete()`, parse, batch-insert, release the claim.

**Contract**: `suggestAssumptions({ supabase, founderId, projectId }): Promise<{ ok: true } | { ok: false, code: "no_claims" | "pending_batch" | "in_progress" | "not_found" | "ai_failed" | "invalid_output", message: string }>`. Order: load project (RLS-scoped) and claims, return `no_claims` / `pending_batch` before any AI spend; take the in-flight claim per Critical Implementation Details; load up to 20 recent rejected statements; call `complete({ taskKind: "suggest", ... })`; map `AIResult` errors to `ai_failed`; parse; insert assumptions (status `suggested`) then link rows; on any failure after the claim, reset `suggest_started_at` to null and leave no partial batch (if the link insert fails, delete is unavailable, so mark the just-inserted rows `rejected` and return `ai_failed`).

#### 4. Fixture test script

**File**: `scripts/test-assumption-suggest.mjs`

**Intent**: Prove parser, prompt and transition-helper invariants without network, in the `scripts/smoke.mjs` step-list style.

**Contract**: Steps cover: valid fixture parses with expected claim links; fenced JSON parses; fewer than 5 or more than 8 suggestions, empty or over-long text, unknown `claim_ids`, non-JSON, and "validated"/"proven" wording all fail; `buildSuggestMessages` includes each claim id and text, the rejected-statements list, and the hypothesis/no-"validated" instruction; `canReview` and `canSetLifecycle` accept and reject the right statuses; exit code non-zero on any failure. Optionally wire into the CI `ci` job after build.

### Success Criteria:

#### Automated Verification:

- Fixture tests pass: `npm run test:assumptions`
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- Reading the prompt confirms assumptions are framed as risky guesses to test, viability wording is forbidden, and rejected statements are excluded from re-suggestion.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding to the next phase.

---

## Phase 3: API routes

### Overview

Expose suggest, review and lifecycle actions as server routes following the existing auth-route conventions.

### Changes Required:

#### 1. Suggest

**File**: `src/pages/api/assumptions/suggest.ts` (new)

**Intent**: Run `suggestAssumptions` for the caller's project and return an outcome the page can render.

**Contract**: `export const prerender = false`; `POST`. 401/redirect to `/auth/signin` if unauthenticated. Looks up the founder's project (RLS-scoped), calls the service, redirects to `/assumptions` on success and to `/assumptions?suggestError=<code>` on failure. `pending_batch` and `in_progress` redirect without error noise.

#### 2. Review (accept / edit-accept / reject)

**File**: `src/pages/api/assumptions/[id]/review.ts` (new)

**Intent**: Apply the founder's decision to one pending suggestion.

**Contract**: `prerender = false`; `POST` with a zod-validated body `{ action: "accept" | "reject", statement?: string (1-280), riskNote?: string (0-280) }`. Accept sets `status = 'active'`, applies a changed `statement`/`riskNote` and sets `edited = true` only if the text actually changed. Reject sets `status = 'rejected'`. Both use a conditional update (`where id = :id and status = 'suggested'`, returning the row); zero rows redirects to `/assumptions?reviewError=not_pending`. `updated_at` set on every update. Validation errors redirect with `?reviewError=invalid`.

#### 3. Lifecycle status

**File**: `src/pages/api/assumptions/[id]/status.ts` (new)

**Intent**: Let the founder set a durable assumption's lifecycle state by hand (FR-011).

**Contract**: `prerender = false`; `POST` with `{ status: "active" | "superseded" | "retired" }` validated by zod. Conditional update (`where id = :id and status in ('active','superseded','retired')`, returning the row) so a `suggested` or `rejected` row can never be moved here; zero rows redirects with `?statusError=not_durable`. Any direction among the three states is allowed.

#### 4. Route protection

**File**: `src/middleware.ts`

**Intent**: Require sign-in for the new page.

**Contract**: Extend `PROTECTED_ROUTES` with `"/assumptions"`; the API routes check `locals.user` themselves, matching S-02.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Build passes: `npm run build`
- Smoke test still passes: `npm run smoke`

#### Manual Verification:

- Calling suggest twice quickly yields one batch, not two.
- Calling suggest while suggested rows exist yields no new rows and no AI spend (no new `ai_usage_events` row).
- Reviewing the same assumption twice (two tabs) accepts once and shows a friendly message the second time.
- Setting status on a `suggested` or `rejected` row via a hand-crafted POST changes nothing.
- Temporarily invalid `OPENROUTER_API_KEY` leaves no new rows and resets `suggest_started_at` to null.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding to the next phase.

---

## Phase 4: UI

### Overview

Give the founder the suggest action, the review cards and the durable list with a status control, and a path to the page.

### Changes Required:

#### 1. Assumptions page

**File**: `src/pages/assumptions.astro`, plus `src/components/assumptions/SuggestionCard.astro` and `src/components/assumptions/AssumptionRow.astro`

**Intent**: Server-rendered page with three regions: a "Suggest assumptions" action, pending suggestion cards, and the durable list. Redirect to `/project/new` if no project exists, and show a "Draft your canvas first" notice linking to `/project` if there are no claims.

**Contract**: Each pending card shows the statement, the risk note, the source claims (block label + text), and a form with editable statement/risk-note fields and Accept / Reject buttons posting to the review route. The suggest action is hidden while pending cards exist (it is shown again once all are resolved) and its button disables on submit; the server guard remains authoritative. Durable rows show the statement, risk note, and a status `<select>` (Active / Superseded / Retired) with a submit button posting to the status route; `superseded` and `retired` rows are visually de-emphasized and labeled in text, not by color alone. If `?suggestError`, `?reviewError` or `?statusError` is set, show a plain-language message (`ai_failed`/`invalid_output` with the same Retry action, `no_claims`, `not_pending`, `not_durable`). Copy frames assumptions as risky guesses to test, never as facts. No React island needed (plain form POSTs, matching S-02).

#### 2. Entry point

**File**: `src/pages/dashboard.astro` or `src/pages/project/index.astro` (whichever S-02 landed as the founder's home)

**Intent**: Add a single link to `/assumptions`, shown only when the project has at least one claim.

**Contract**: One extra server-side query via `createClient`; label e.g. "Assumptions".

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Build passes: `npm run build`
- Smoke test still passes: `npm run smoke`

#### Manual Verification:

- End to end on local Supabase with a real key: sign up, create project, draft canvas, suggest, edit-and-accept one, accept one, reject one, then set statuses.
- Reload keeps all state; a second batch can only be requested after the first is fully resolved; a rejected statement does not reappear in the next batch (spot check).
- Forced failure shows the message and Retry; retry succeeds once the key is fixed.
- A second account cannot see the first account's assumptions.
- Status labels are perceivable without color; forms are fully keyboard-operable.
- No page copy or AI output uses "validated" or "proven".

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human.

---

## Testing Strategy

### Unit Tests:

- `parseSuggestions`, `buildSuggestMessages`, `canReview`, `canSetLifecycle` via `npm run test:assumptions` (valid, fenced, malformed, count bounds, unknown claim ids, forbidden wording).

### Integration Tests:

- `supabase/tests/assumptions.sql`: vocabulary, insert-as-suggested guard, RLS isolation, no DELETE.
- Existing `npm run smoke` confirms auth is unaffected.

### Manual Testing Steps:

1. Run `npx supabase start` and `npx supabase db reset`; start the app with a real `OPENROUTER_API_KEY`.
2. With a drafted canvas, suggest; inspect `assumptions` (all `suggested`, `origin = 'ai_suggested'`), `assumption_claims`, and one `ai_usage_events` row with kind `suggest`.
3. Accept (one edited, one unedited) and reject one; confirm `status`, `edited`, and `updated_at`.
4. Try suggesting again while pending rows remain (refused, no usage row), then resolve all and suggest again.
5. Set an assumption through `superseded` → `retired` → `active`.
6. Break the API key; confirm failure message, no rows, and a working retry.

## Performance Considerations

Suggestion is one synchronous call bounded by F-02's 15s `suggest` timeout plus one retry (worst case roughly 31s). Batch size is capped at 8 and the prompt carries at most 9 blocks x 5 claims, so prompt size is small. If this proves too slow on the Workers runtime, options are a smaller `max_tokens` or a faster model for `suggest` (a one-line change in F-02's task config); a queue is out of scope.

## Migration Notes

Pre-launch, no data to migrate. Rollback is dropping `assumption_claims`, then `assumptions`, then `projects.suggest_started_at`. The migration must sort after S-02's.

## References

- Roadmap: `context/foundation/roadmap.md` (S-04)
- PRD: `context/foundation/prd.md` (FR-009, FR-010, FR-011, Guardrails)
- Prerequisite plans: `context/changes/data-workspace-scaffold/plan.md`, `context/changes/ai-provider-integration/plan.md`, `context/changes/ai-drafted-canvas-from-brief/plan.md`
- Patterns: `src/pages/api/auth/signup.ts`, `src/middleware.ts`, `scripts/smoke.mjs`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema and shared types

#### Automated

- [ ] 1.1 Migration applies on a fresh DB: `npx supabase db reset`
- [ ] 1.2 No migration lint errors: `npx supabase db lint`
- [ ] 1.3 SQL assertions pass: `psql ... -f supabase/tests/assumptions.sql`
- [ ] 1.4 Type checking passes: `npx astro check`
- [ ] 1.5 Linting passes: `npm run lint`

#### Manual

- [ ] 1.6 Studio shows RLS enabled on both tables with the expected policies

### Phase 2: Suggestion service

#### Automated

- [ ] 2.1 Fixture tests pass: `npm run test:assumptions`
- [ ] 2.2 Type checking passes: `npx astro check`
- [ ] 2.3 Linting passes: `npm run lint`
- [ ] 2.4 Build passes: `npm run build`

#### Manual

- [ ] 2.5 Prompt reviewed: assumptions framed as risky guesses, viability wording forbidden, rejected statements excluded

### Phase 3: API routes

#### Automated

- [ ] 3.1 Type checking passes: `npx astro check`
- [ ] 3.2 Linting passes: `npm run lint`
- [ ] 3.3 Build passes: `npm run build`
- [ ] 3.4 Smoke test still passes: `npm run smoke`

#### Manual

- [ ] 3.5 Rapid double suggest call yields a single batch
- [ ] 3.6 Suggest with pending rows yields no new rows and no usage event
- [ ] 3.7 Double review of one assumption accepts once and shows a friendly message
- [ ] 3.8 Status change on a suggested or rejected row is refused
- [ ] 3.9 Invalid API key leaves no new rows and resets `suggest_started_at`

### Phase 4: UI

#### Automated

- [ ] 4.1 Type checking passes: `npx astro check`
- [ ] 4.2 Linting passes: `npm run lint`
- [ ] 4.3 Build passes: `npm run build`
- [ ] 4.4 Smoke test still passes: `npm run smoke`

#### Manual

- [ ] 4.5 End-to-end: suggest, edit-accept, accept, reject, set statuses on local Supabase with a real key
- [ ] 4.6 Reload keeps state; new batch only after the previous is resolved; rejected statement does not reappear
- [ ] 4.7 Forced failure shows message and Retry; retry succeeds after fixing key
- [ ] 4.8 Second account cannot see the first account's assumptions
- [ ] 4.9 Status labels perceivable without color; forms keyboard-operable
- [ ] 4.10 No page copy or AI output uses "validated" or "proven"
