# AI-Drafted Canvas from Brief Implementation Plan

## Overview

A verified founder creates their one project from a short rough-notes brief and gets an AI-drafted Business Model Canvas (9 blocks). Every AI-authored claim is persisted with `origin = 'ai_draft'` and rendered with a visible "AI draft" badge, distinct from founder-authored claims. This is slice S-02 in `context/foundation/roadmap.md` (PRD FR-005, FR-006).

## Current State Analysis

- No domain schema exists: `supabase/` has only `config.toml`; no `migrations/`, no `src/types.ts`.
- Prerequisites are **planned but not implemented**:
  - F-01 (`context/changes/data-workspace-scaffold/plan.md`) defines `workspaces`, `workspace_members`, the `is_workspace_member(ws uuid)` helper and the signup trigger.
  - F-02 (`context/changes/ai-provider-integration/plan.md`) defines `complete({ taskKind, messages, supabase, founderId })` in `src/lib/ai.ts`, returning `AIResult` (`{ ok: true, text, usage, model } | { ok: false, error: { kind, message } }`), with task kind `draft` (15s timeout, one retry).
  - S-01 (`verified-account-and-workspace`) is only a stub; email verification is not enforced yet. This slice does not depend on it beyond `locals.user`.
- App surface today: auth pages, `/dashboard` (a static welcome card), `src/middleware.ts` with `PROTECTED_ROUTES = ["/dashboard"]`, one shadcn primitive (`src/components/ui/button.tsx`). API routes read `createClient(request.headers, cookies)` and redirect on error (`src/pages/api/auth/signup.ts`).
- `zod` is mandated by CLAUDE.md for API validation but is not in `package.json`.
- No test runner; convention is zero-dependency Node scripts (`scripts/smoke.mjs`) and SQL assertion scripts (F-01 plan).

## Desired End State

A signed-in founder with a workspace can:

1. Submit a rough-notes brief at `/project/new` and land on `/project`, with the project saved.
2. See an AI-drafted canvas (9 BMC blocks, 1-5 claims each) where every claim carries an "AI draft" badge.
3. If drafting fails, see a recoverable message with a Retry button; the brief is never lost.
4. Not be able to create a second project, and not be able to re-draft once claims exist.

Verification: `npm run test:canvas` and the SQL test pass; `npm run lint`, `npx astro check`, `npm run build` and `npm run smoke` stay green; a manual end-to-end run against local Supabase and a real OpenRouter key produces a badged canvas.

### Key Discoveries:

- `is_workspace_member()` (F-01) is the single RLS predicate to reuse for both new tables.
- `complete()` returns raw assistant text only; parsing and validation belong to this slice (F-02 "What We're NOT Doing").
- Shape notes name the marker value `origin: ai_draft`, and require that a failed save never lets generation proceed on lost text, so the brief must be persisted before drafting starts.
- Node 22.14 (`.nvmrc`) cannot import `.ts` without `--experimental-strip-types`, and `@/` aliases do not resolve in plain Node.

## What We're NOT Doing

- No manual claim editing, and no revision conflict handling (S-03). The `revision` column is added now but unused.
- No assumption suggestion (S-04), critique, or any rehearsal feature.
- No "regenerate draft" and no deletion of claims.
- No email-verification gate or password reset (S-01).
- No background queue or Workflow; drafting is one synchronous request within F-02's timeout.
- No multi-project support, no project list UI, no project deletion.
- No new test framework.

## Implementation Approach

Persist first, draft second. `POST /api/projects` stores the brief; `POST /api/projects/draft` takes a lightweight claim on the project, calls `complete()` with kind `draft`, validates the JSON with zod, and inserts all claims in one batch. Pure logic (prompt builder, zod schema, parser, block list) lives in a dependency-free module so it can be tested with a plain Node script. The database enforces invariants (one project per workspace, valid block and origin values), and the app maps violations to friendly messages.

## Critical Implementation Details

- **Draft race protection.** Double-clicks or two tabs must not produce two drafts. Add `projects.draft_started_at timestamptz`. The draft route first runs a conditional update (`draft_started_at is null or draft_started_at < now() - interval '60 seconds'`, returning the row) and proceeds only if it gets a row. It also refuses if any claims already exist. On AI or validation failure it resets `draft_started_at` to null. The 60s staleness window recovers from a worker dying mid-draft.
- **Pure module must be Node-importable.** `src/lib/services/canvas-draft.ts` must import nothing from `astro:*` or `@/`; use relative imports only. The test script runs with `node --experimental-strip-types`. The route-side orchestration lives in a separate file so this boundary stays clean.
- **AI-claim honesty.** Prompt must instruct the model that claims are hypotheses to be tested, not facts, and must forbid wording like "validated" or "proven" (PRD guardrail). The parser should reject output containing those words so a violating draft counts as a failure.

## Phase 1: Schema and shared types

### Overview

Introduce the `projects` and `canvas_claims` tables with RLS, enforce the one-project cap and claim vocabulary in the database, and add shared types.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/<timestamp>_projects_and_canvas_claims.sql` (generate timestamp at implementation time, `YYYYMMDDHHmmss`)

**Intent**: Create the two tables, constraints, indexes and per-operation `authenticated` RLS policies in one migration so the slice's data contract lands or fails together.

**Contract**:

- `public.projects(id uuid pk default gen_random_uuid(), workspace_id uuid not null unique references workspaces on delete cascade, brief text not null check (char_length(brief) between 20 and 2000), draft_started_at timestamptz, created_at timestamptz not null default now())`. The `unique` on `workspace_id` is the FR-005 cap.
- `public.canvas_claims(id uuid pk default gen_random_uuid(), project_id uuid not null references projects on delete cascade, block text not null check (block in ('key_partners','key_activities','key_resources','value_propositions','customer_relationships','channels','customer_segments','cost_structure','revenue_streams')), position integer not null, text text not null check (char_length(text) between 1 and 280), origin text not null check (origin in ('ai_draft','founder')), revision integer not null default 1, created_at timestamptz not null default now(), unique (project_id, block, position))`.
- RLS enabled on both. Policies for `authenticated` only, one per operation: `projects` SELECT, INSERT (with check `is_workspace_member(workspace_id)`), UPDATE (using + with check same predicate); `canvas_claims` SELECT and INSERT gated by membership of the parent project's workspace (via a subquery or a small `SECURITY DEFINER` helper `is_project_member(project uuid)` with pinned `search_path`). No DELETE policies, and no claim UPDATE policy in this slice (S-03 adds it). No `anon` policies.

#### 2. Shared types

**File**: `src/types.ts`

**Intent**: Add `Project`, `CanvasClaim`, `CanvasBlockKey` (string union of the 9 blocks) and `ClaimOrigin` (`"ai_draft" | "founder"`) per CLAUDE.md. If F-01 has already created this file, append; otherwise create it.

**Contract**: Field names mirror the columns above.

#### 3. SQL assertion script

**File**: `supabase/tests/projects_and_canvas_claims.sql`

**Intent**: Prove the cap, vocabulary constraints and cross-user RLS isolation, following the F-01 test's pattern (single transaction, rolled back, `ON_ERROR_STOP`).

**Contract**: With two users and their workspaces: a second project in the same workspace is rejected; an invalid `block` or `origin` is rejected; user A cannot select or insert projects or claims for user B's workspace; each user sees only their own rows.

### Success Criteria:

#### Automated Verification:

- Migration applies on a fresh DB: `npx supabase db reset`
- No migration lint errors: `npx supabase db lint`
- SQL assertions pass: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/projects_and_canvas_claims.sql`
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`

#### Manual Verification:

- Studio shows RLS enabled on both tables with the expected policies.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding to the next phase.

---

## Phase 2: Canvas draft service

### Overview

Build and test the pure drafting logic, then the thin orchestration that calls F-02 and persists claims.

### Changes Required:

#### 1. Dependency

**File**: `package.json`

**Intent**: Add `zod` as a dependency (CLAUDE.md mandates it for validation) and a `test:canvas` script.

**Contract**: `"test:canvas": "node --experimental-strip-types scripts/test-canvas-draft.mjs"`.

#### 2. Pure drafting module

**File**: `src/lib/services/canvas-draft.ts` (new; relative imports only)

**Intent**: Own everything about the draft's shape, independent of Astro and Supabase.

**Contract**: Exports `CANVAS_BLOCKS` (ordered array of the 9 keys, with display labels), `buildDraftMessages(brief: string)` returning chat messages for `complete()`, a zod `DraftSchema` (object keyed by the 9 blocks, each an array of 1-5 strings of 1-280 chars), and `parseDraft(raw: string)` returning `{ ok: true, claims: { block, position, text }[] } | { ok: false, reason: string }`. `parseDraft` strips optional code fences before `JSON.parse`, fails on schema violations, and fails if any claim contains "validated" or "proven" (case-insensitive).

#### 3. Orchestration

**File**: `src/lib/services/canvas-draft-service.ts` (new)

**Intent**: Take the draft claim, call `complete()`, parse, batch-insert claims, release the claim on failure.

**Contract**: `draftCanvas({ supabase, founderId, projectId }): Promise<{ ok: true } | { ok: false, code: "already_drafted" | "in_progress" | "not_found" | "ai_failed" | "invalid_output", message: string }>`. Implements the Critical Implementation Details race protocol; calls `complete({ taskKind: "draft", ... })`; inserts claims with `origin: "ai_draft"` in one insert; maps `AIResult` errors to `ai_failed`.

#### 4. Fixture test script

**File**: `scripts/test-canvas-draft.mjs`

**Intent**: Prove parser and prompt invariants without network, in the `scripts/smoke.mjs` step-list style.

**Contract**: Steps cover: valid fixture parses to expected claim positions; fenced JSON parses; missing block, empty array, 6 claims, over-long text, non-JSON, and "validated" wording all fail; `buildDraftMessages` includes the brief and the hypothesis/no-"validated" instruction; exit code non-zero on any failure. Optionally wire into the CI `ci` job after build.

### Success Criteria:

#### Automated Verification:

- Fixture tests pass: `npm run test:canvas`
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- Reading the prompt confirms it frames claims as hypotheses and forbids viability wording.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding to the next phase.

---

## Phase 3: API routes

### Overview

Expose project creation and drafting as server routes following the existing auth-route conventions.

### Changes Required:

#### 1. Create project

**File**: `src/pages/api/projects/index.ts` (new)

**Intent**: Create the founder's one project from a brief. Validate with zod (brief 20-2000 chars), resolve the founder's workspace via their membership row, insert the project, and map a unique violation on `workspace_id` to a clear "You already have a project" error.

**Contract**: `export const prerender = false`; `POST` only. Rejects unauthenticated requests (401 or redirect to `/auth/signin`). Success redirects to `/project`; validation or cap errors redirect to `/project/new?error=...`, matching the signup route's pattern.

#### 2. Draft canvas

**File**: `src/pages/api/projects/draft.ts` (new)

**Intent**: Run `draftCanvas` for the caller's project and return a typed outcome the UI can act on.

**Contract**: `prerender = false`; `POST`. Looks up the founder's project (RLS-scoped), calls `draftCanvas`, redirects to `/project` on success, and to `/project?draftError=<code>` on failure so the page can render a message and a Retry form. `already_drafted` and `in_progress` redirect without error noise.

#### 3. Route protection

**File**: `src/middleware.ts`

**Intent**: Require sign-in for the new pages.

**Contract**: Extend `PROTECTED_ROUTES` with `"/project"` (prefix match already covers `/project/new` and `/api/projects` is handled in-route).

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Build passes: `npm run build`
- Smoke test still passes: `npm run smoke`

#### Manual Verification:

- Creating a project twice yields the friendly cap message, with one `projects` row.
- Calling the draft route twice quickly yields one set of claims, not two.
- Temporarily invalid `OPENROUTER_API_KEY` leaves the project with no claims and `draft_started_at` reset to null.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding to the next phase.

---

## Phase 4: UI

### Overview

Give the founder a brief form, a canvas view with distinct AI marking, and a path from the dashboard.

### Changes Required:

#### 1. Brief form page

**File**: `src/pages/project/new.astro`

**Intent**: Server-rendered form posting to `/api/projects`, with a textarea (20-2000 chars, character hint), inline error from `?error=`, and copy that frames the output as a starting point to challenge. Redirect to `/project` if the founder already has a project.

**Contract**: Uses `Layout.astro`; no React island needed (plain form POST like the dashboard's signout).

#### 2. Canvas page

**File**: `src/pages/project/index.astro`, plus `src/components/canvas/ClaimCard.astro` and `src/components/canvas/CanvasBoard.astro`

**Intent**: Show the brief and the 9 blocks in BMC order. Each claim renders with an "AI draft" badge when `origin = 'ai_draft'` and no badge/different styling for `founder`. With zero claims, show a "Draft my canvas" action posting to `/api/projects/draft`; if `?draftError` is set, show a plain-language message (timeout/provider/invalid output) and the same action as Retry. Redirect to `/project/new` if no project exists.

**Contract**: Badge text must be unambiguous (e.g. "AI draft"), include an accessible label, and not rely on color alone. A short note states AI claims are hypotheses to review and edit. Submit button disables on submit to limit double-posts; the server-side race protection remains authoritative.

#### 3. Dashboard entry

**File**: `src/pages/dashboard.astro`

**Intent**: Add a single link/button: "Create your project" (no project) or "Open your project" (project exists).

**Contract**: One extra server-side query for project existence via `createClient`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Build passes: `npm run build`
- Smoke test still passes: `npm run smoke`

#### Manual Verification:

- End to end on local Supabase with a real key: sign up, create a project from a brief, draft, and see 9 blocks of badged AI claims.
- Reloading `/project` keeps the canvas; the draft action is no longer offered once claims exist.
- Forced failure shows the message and Retry, and a retry succeeds once the key is fixed.
- A second account cannot see the first account's project or claims.
- Badge is perceivable in light/dark and without color; keyboard flow works for the form and retry.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human.

---

## Testing Strategy

### Unit Tests:

- `parseDraft` and `buildDraftMessages` via `npm run test:canvas` (valid, fenced, malformed, out-of-bounds, forbidden wording).

### Integration Tests:

- `supabase/tests/projects_and_canvas_claims.sql`: cap, vocabulary constraints, RLS isolation.
- Existing `npm run smoke` confirms auth is unaffected.

### Manual Testing Steps:

1. Run `npx supabase start` and `npx supabase db reset`; start the app with a real `OPENROUTER_API_KEY`.
2. Sign up, create a project, draft, and inspect `canvas_claims` (all `origin = 'ai_draft'`) and one `ai_usage_events` row.
3. Attempt a second project and a second draft; confirm both are refused cleanly.
4. Break the API key; confirm failure message, no claims, and a working retry afterwards.

## Performance Considerations

Drafting is one synchronous call bounded by F-02's 15s `draft` timeout plus one retry (worst case roughly 31s). If that proves too slow on the Workers runtime, the options are a smaller `max_tokens`, a faster model for `draft`, or a Workflow. All of these are out of scope here; revisit with real measurements.

## Migration Notes

Pre-launch, no data to migrate. Rollback is dropping the two tables (claims first) and the optional `is_project_member` helper.

## References

- Roadmap: `context/foundation/roadmap.md` (S-02)
- PRD: `context/foundation/prd.md` (FR-005, FR-006, Guardrails)
- Prerequisite plans: `context/changes/data-workspace-scaffold/plan.md`, `context/changes/ai-provider-integration/plan.md`
- Patterns: `src/pages/api/auth/signup.ts`, `src/middleware.ts`, `scripts/smoke.mjs`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema and shared types

#### Automated

- [ ] 1.1 Migration applies on a fresh DB: `npx supabase db reset`
- [ ] 1.2 No migration lint errors: `npx supabase db lint`
- [ ] 1.3 SQL assertions pass: `psql ... -f supabase/tests/projects_and_canvas_claims.sql`
- [ ] 1.4 Type checking passes: `npx astro check`
- [ ] 1.5 Linting passes: `npm run lint`

#### Manual

- [ ] 1.6 Studio shows RLS enabled on both tables with the expected policies

### Phase 2: Canvas draft service

#### Automated

- [ ] 2.1 Fixture tests pass: `npm run test:canvas`
- [ ] 2.2 Type checking passes: `npx astro check`
- [ ] 2.3 Linting passes: `npm run lint`
- [ ] 2.4 Build passes: `npm run build`

#### Manual

- [ ] 2.5 Prompt reviewed: claims framed as hypotheses, viability wording forbidden

### Phase 3: API routes

#### Automated

- [ ] 3.1 Type checking passes: `npx astro check`
- [ ] 3.2 Linting passes: `npm run lint`
- [ ] 3.3 Build passes: `npm run build`
- [ ] 3.4 Smoke test still passes: `npm run smoke`

#### Manual

- [ ] 3.5 Second project creation yields friendly cap message and one row
- [ ] 3.6 Rapid double draft call yields a single set of claims
- [ ] 3.7 Invalid API key leaves no claims and resets `draft_started_at`

### Phase 4: UI

#### Automated

- [ ] 4.1 Type checking passes: `npx astro check`
- [ ] 4.2 Linting passes: `npm run lint`
- [ ] 4.3 Build passes: `npm run build`
- [ ] 4.4 Smoke test still passes: `npm run smoke`

#### Manual

- [ ] 4.5 End-to-end: brief to project to badged 9-block canvas on local Supabase with a real key
- [ ] 4.6 Reload keeps canvas; draft action hidden once claims exist
- [ ] 4.7 Forced failure shows message and Retry; retry succeeds after fixing key
- [ ] 4.8 Second account cannot see the first account's data
- [ ] 4.9 Badge perceivable without color; form and retry keyboard-accessible
