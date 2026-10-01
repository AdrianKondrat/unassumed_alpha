# Manual Canvas Editing with Conflict Safety Implementation Plan

## Overview

Let a founder edit, add and delete Business Model Canvas claims by hand, with no AI involved (FR-007). Every claim carries a version; each save is a version-checked write, so two edits racing against the same saved version yield one accepted update and one flagged conflict instead of silent loss (FR-008). This is roadmap slice S-03.

## Current State Analysis

- No canvas code, canvas tables, or `supabase/migrations/` directory exist yet. The only app data path is Supabase auth via form POST → API route → redirect (`src/pages/api/auth/signin.ts`).
- Upstream work is planned but not implemented: F-01 (`data-workspace-scaffold`: `workspaces`, `workspace_members`, `is_workspace_member()` RLS pattern, `src/types.ts`) and S-01 (verified account + workspace dashboard).
- S-02 (`ai-drafted-canvas-from-brief`) has only a `change.md`; its schema and canvas page are undecided. S-03 depends on its shape.
- `src/middleware.ts` resolves `locals.user` and redirects unauthenticated users only for `PROTECTED_ROUTES` (page routes). API routes must enforce auth themselves.
- Only one shadcn primitive (`button.tsx`) is installed. `scripts/smoke.mjs` is a dependency-free fetch-based test with a cookie jar.

## Desired End State

On the canvas page a founder can edit a claim's text, add a claim to any of the 9 BMC blocks, and delete a claim. Saving from a stale version never overwrites: the founder sees "your edit" next to "saved version" and chooses Keep mine or Use saved. A manual text edit marks the claim founder-authored. Verified by: the SQL race script passing, the smoke conflict case passing in CI, and a manual two-tab check.

### Key Discoveries:

- FR-008 requires one accepted and one flagged edit per race; a single version-checked `UPDATE ... WHERE id = ? AND version = ?` gives that atomically with no locks.
- RLS on later tables should reuse F-01's `is_workspace_member(ws uuid)` predicate (see `context/changes/data-workspace-scaffold/plan.md`, Phase 2).
- API routes need `export const prerender = false`, uppercase method exports, and zod validation (CLAUDE.md).
- The existing auth routes use form + redirect; this feature needs JSON responses because a conflict must return the current row to an interactive island.

## What We're NOT Doing

- AI drafting or AI edits (S-02), assumption derivation (S-04).
- Reordering claims, drag-and-drop, or changing the fixed 9-block set.
- Automatic three-way text merge, locking, real-time sync or presence.
- Edit history or "originally AI-drafted" provenance beyond the current `author_kind`.
- Vitest or any new test dependency; no browser-automation UI tests.
- Defining S-02's tables, the project-creation flow, or the canvas page itself.

## Implementation Approach

Optimistic concurrency at the claim level. A per-claim integer `version` is loaded with the claim and sent back on every write. The database enforces the rule (a trigger forces `version + 1`; the conditional write matches on the old version), the API translates zero-rows-affected into a 409 carrying the current row, and the UI turns a 409 into an inline resolver. Layers are built bottom-up so each phase is independently verifiable.

### Assumed S-02 contract

S-03 is planned against this minimal contract. S-02's plan must honor it, or this plan must be revisited when S-02 is planned:

- `public.canvas_claims(id uuid pk, workspace_id uuid fk workspaces, project_id uuid, block text, text text, author_kind text check in ('ai','founder'), version int not null default 1, created_at, updated_at)`. RLS is enabled, with `SELECT` and `INSERT` policies gated by `is_workspace_member(workspace_id)`.
- `block` holds one of nine BMC block keys (customer segments, value propositions, channels, customer relationships, revenue streams, key resources, key activities, key partnerships, cost structure). S-02 owns the key list; S-03 imports it from a single shared constant.
- A canvas page (S-02) renders the claims server-side; S-03 mounts the editor island on it and passes claims as initial props.

## Critical Implementation Details

- **State sequencing.** On a successful save the client must replace its stored version with the version returned by the server before the next edit; reusing the old version makes the founder's own consecutive saves conflict with themselves.
- **Delete conflict rules.** A delete whose version no longer matches is a conflict only if the row still exists. If the row is already gone, treat the delete as done (idempotent) and drop it from the UI. An edit of a claim deleted elsewhere returns 404, and the UI offers to re-add the founder's text as a new claim.
- **Server owns `author_kind` and `version`.** Clients never send them as writable fields apart from the expected-version precondition; a trigger enforces the version bump so a buggy route cannot skip it.

## Phase 1: Conflict-safe write rules in the database

### Overview

Add the write-side RLS policies and version enforcement to `canvas_claims`, and prove the race behaviour in SQL before any app code exists.

### Changes Required:

#### 1. Migration for write policies and version trigger

**File**: `supabase/migrations/<timestamp>_canvas_claims_conflict_safety.sql` (`YYYYMMDDHHmmss`, generated at implementation time)

**Intent**: Allow founders to update and delete their workspace's claims (insert exists from S-02), and make the version bump unskippable.

**Contract**: Per-operation `authenticated`-only policies on `canvas_claims`: `UPDATE` (using and with check `is_workspace_member(workspace_id)`) and `DELETE` (using `is_workspace_member(workspace_id)`); no `anon` policies. A `BEFORE UPDATE` trigger function (`set search_path = ''`) sets `new.version = old.version + 1` and `new.updated_at = now()`, and rejects changes to `workspace_id`, `project_id`. A check constraint limits `block` to the nine keys if S-02 has not already added one; `text` is non-empty and capped (e.g. 2000 chars).

#### 2. SQL assertion script

**File**: `supabase/tests/canvas_conflict_safety.sql`

**Intent**: Prove the FR-008 guarantee and tenant isolation against a reset local DB.

**Contract**: Single rolled-back script, run with `psql -v ON_ERROR_STOP=1` like F-01's. It inserts two users, a claim for user A, then asserts: a version-matched update affects one row and bumps the version; a second update using the now-stale version affects zero rows; a stale-version delete affects zero rows; user B's update and delete on A's claim affect zero rows; an update that tries to change `workspace_id` raises.

### Success Criteria:

#### Automated Verification:

- Migrations apply on a clean DB: `npx supabase db reset`
- Assertion script passes: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/canvas_conflict_safety.sql`
- DB lint is clean: `npx supabase db lint`

#### Manual Verification:

- In Studio, updating a claim twice shows `version` going 1 → 2 → 3 and `updated_at` changing.

**Implementation Note**: After this phase and its automated checks pass, pause for manual confirmation before Phase 2.

---

## Phase 2: Claims API

### Overview

Expose create, update and delete as JSON endpoints that translate stale writes into 409 conflicts.

### Changes Required:

#### 1. Shared types and block constant

**File**: `src/types.ts`

**Intent**: Add the entity and DTO types the API and UI share.

**Contract**: `CanvasClaim`, `ClaimAuthorKind = "ai" | "founder"`, `CanvasBlockKey`, request DTOs (`UpdateClaimRequest { text, expectedVersion }`, `CreateClaimRequest { block, text }`, `DeleteClaimRequest { expectedVersion }`), and a conflict response type `{ error: "conflict", current: CanvasClaim }`. The block-key constant is imported from S-02's definition if present, otherwise defined once here.

#### 2. Claims service

**File**: `src/lib/services/claims.ts`

**Intent**: Hold the conflict logic so the routes stay thin.

**Contract**: `updateClaim`, `createClaim`, `deleteClaim` take the request-scoped Supabase client plus validated input and return a discriminated result: `ok`, `conflict` (with the current row), `not_found`, or `error`. `updateClaim` runs `.update({ text, author_kind: "founder" }).eq("id", id).eq("version", expectedVersion).select()`; zero returned rows triggers a follow-up select to distinguish `conflict` from `not_found`. `deleteClaim` treats an already-missing row as `ok`. An unchanged-text save is a no-op returning the current row without bumping the version.

#### 3. API routes

**Files**: `src/pages/api/claims/index.ts` (`POST`), `src/pages/api/claims/[id].ts` (`PATCH`, `DELETE`)

**Intent**: JSON endpoints with zod validation and explicit auth, since middleware redirects don't suit API clients.

**Contract**: `export const prerender = false`. Return 401 JSON when there is no user, 400 on zod failure (trimmed non-empty text, max length, valid block key, positive integer version), 200/201 with the claim, 404, or 409 with the conflict body above. Never echo internal error details.

### Success Criteria:

#### Automated Verification:

- Type checking and lint pass: `npm run lint`
- Production build succeeds: `npm run build`

#### Manual Verification:

- With `curl` or the browser devtools while signed in: PATCH with the current version returns 200 and the version increments; PATCH again with the old version returns 409 including the saved row; unauthenticated PATCH returns 401.

**Implementation Note**: Pause for manual confirmation after this phase's checks pass.

---

## Phase 3: Editor UI

### Overview

Give the founder an inline editor with a conflict resolver, mounted on S-02's canvas page.

### Changes Required:

#### 1. Editor state hook

**File**: `src/components/hooks/useClaimEditor.ts`

**Intent**: Own claim list state, per-claim save status and the stored version per claim.

**Contract**: Exposes `claims`, `saveClaim(id, text)`, `addClaim(block, text)`, `removeClaim(id)`, and a per-claim `conflict` object (`mine`, `saved`) when a save returns 409. Replaces the stored version from every successful response. `resolveKeepMine(id)` re-saves the founder's text against the returned current version; `resolveUseSaved(id)` discards the local draft. Both handle a further 409 by showing the resolver again.

#### 2. Editor components

**Files**: `src/components/canvas/CanvasEditor.tsx`, `src/components/canvas/ClaimItem.tsx`, `src/components/canvas/ConflictResolver.tsx`

**Intent**: Render the nine blocks with their claims, inline edit/add/delete, and a side-by-side "Your edit / Saved version" resolver with Keep mine and Use saved actions.

**Contract**: `CanvasEditor` takes `initialClaims: CanvasClaim[]`. Each claim shows a distinct AI-drafted vs founder-authored badge (same marking S-02 introduces; do not redefine its styling). Saves are explicit (Save/Cancel, plus Escape to cancel) rather than on every keystroke. The resolver is inline per claim, keyboard-reachable, and announces itself via `role="alert"`. Delete asks for a confirmation step. Use `cn()` for class merging; add a shadcn `textarea` with `npx shadcn@latest add textarea`. No Next.js directives.

#### 3. Mount on the canvas page

**File**: S-02's canvas page (path decided in S-02, e.g. `src/pages/canvas.astro`)

**Intent**: Replace the read-only claim rendering with `<CanvasEditor client:load initialClaims={claims} />`, passing server-fetched claims.

**Contract**: The page stays server-rendered and listed in `PROTECTED_ROUTES`; no change to how S-02 fetches claims beyond including `version` and `author_kind`.

### Success Criteria:

#### Automated Verification:

- Lint and format pass: `npm run lint && npm run format`
- Production build succeeds: `npm run build`

#### Manual Verification:

- Editing, adding and deleting a claim persists after a page refresh.
- Editing an AI-drafted claim changes its badge to founder-authored.
- Two tabs on the same claim: save in tab A, then save in tab B shows the resolver with both versions; Keep mine saves, Use saved discards.
- Two consecutive saves in one tab never conflict with each other.
- Keyboard-only operation works for edit, save, cancel and the resolver.

**Implementation Note**: Pause for manual confirmation after this phase.

---

## Phase 4: Smoke coverage and hardening

### Overview

Lock the race guarantee into CI through the real HTTP path.

### Changes Required:

#### 1. Smoke conflict case

**File**: `scripts/smoke.mjs`

**Intent**: After signing in (and S-01/S-02 fixtures exist), exercise create → update → stale update → delete through the API.

**Contract**: Create a claim; fire two PATCH requests with the same expected version concurrently and assert exactly one 200 and one 409 whose body contains the saved row; assert a stale delete returns 409 and a current-version delete returns 200. Stays dependency-free and uses the existing cookie jar helper.

### Success Criteria:

#### Automated Verification:

- Smoke passes against a running server with local Supabase: `npm run smoke`
- Lint and build pass: `npm run lint && npm run build`

#### Manual Verification:

- Run the Phase 3 two-tab checklist once against `npm run preview`.

---

## Testing Strategy

### Unit Tests:

- None added (no test runner in the repo by decision); logic is covered at the SQL and HTTP levels.

### Integration Tests:

- `supabase/tests/canvas_conflict_safety.sql`: stale update/delete rejection, version bump, cross-user isolation, immutable ownership columns.
- `scripts/smoke.mjs`: concurrent PATCH yields one 200 and one 409.

### Manual Testing Steps:

1. Sign in, open the canvas, edit a claim and refresh to confirm persistence.
2. Open the canvas in two tabs, edit the same claim in both, save A then B, and resolve with each option.
3. Delete a claim in tab A, then edit it in tab B and confirm the "deleted elsewhere" path.
4. Edit an AI-drafted claim and confirm the badge flips.

## Performance Considerations

Single-row writes keyed by primary key; no extra indexes beyond S-02's. A canvas holds tens of claims, so the whole list ships as initial props.

## Migration Notes

Additive migration on a table that S-02 creates; no data backfill. If S-02's schema differs from the assumed contract, adapt Phase 1 and the types before implementing.

## References

- Roadmap: `context/foundation/roadmap.md` (S-03)
- PRD: `context/foundation/prd.md` (FR-006, FR-007, FR-008)
- RLS pattern: `context/changes/data-workspace-scaffold/plan.md` (Phase 2)
- Auth route conventions: `src/pages/api/auth/signin.ts`, `src/middleware.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Conflict-safe write rules in the database

#### Automated

- [ ] 1.1 Migrations apply on a clean DB: `npx supabase db reset`
- [ ] 1.2 Assertion script passes: `psql ... -f supabase/tests/canvas_conflict_safety.sql`
- [ ] 1.3 DB lint is clean: `npx supabase db lint`

#### Manual

- [ ] 1.4 In Studio, updating a claim twice shows `version` going 1 → 2 → 3 and `updated_at` changing

### Phase 2: Claims API

#### Automated

- [ ] 2.1 Type checking and lint pass: `npm run lint`
- [ ] 2.2 Production build succeeds: `npm run build`

#### Manual

- [ ] 2.3 PATCH with current version returns 200; stale version returns 409 with saved row; unauthenticated returns 401

### Phase 3: Editor UI

#### Automated

- [ ] 3.1 Lint and format pass: `npm run lint && npm run format`
- [ ] 3.2 Production build succeeds: `npm run build`

#### Manual

- [ ] 3.3 Editing, adding and deleting a claim persists after refresh
- [ ] 3.4 Editing an AI-drafted claim changes its badge to founder-authored
- [ ] 3.5 Two-tab edit shows the resolver; Keep mine saves, Use saved discards
- [ ] 3.6 Two consecutive saves in one tab never conflict with each other
- [ ] 3.7 Keyboard-only operation works for edit, save, cancel and the resolver

### Phase 4: Smoke coverage and hardening

#### Automated

- [ ] 4.1 Smoke passes against a running server with local Supabase: `npm run smoke`
- [ ] 4.2 Lint and build pass: `npm run lint && npm run build`

#### Manual

- [ ] 4.3 Phase 3 two-tab checklist re-run against `npm run preview`
