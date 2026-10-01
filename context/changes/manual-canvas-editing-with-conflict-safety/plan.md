# Manual Canvas Editing with Conflict Safety Implementation Plan

> **IMPLEMENTED on `mvp` (2026-10-01, session 3), reconciled against the real S-02 schema.** See "Implementation notes" at the end of Progress. Names differ from the text below: the migration is `20261001100700_canvas_claims_editing.sql`, the version column is `revision`, provenance is `origin`, there is no `updated_at`, routes take `expectedRevision`, and new claims go through the `add_canvas_claim` DB function.

> **RECONCILE BEFORE IMPLEMENTING (written 2026-10-01).** This plan assumed an S-02 schema that the real S-02 plan does not use. Use S-02's actual `canvas_claims`: provenance column is `origin` (`'ai_draft' | 'founder'`), the version column is `revision` (not `version`), and there is **no `workspace_id` and no `updated_at`** on claims. Tenant access goes through `projects.workspace_id` via S-02's `is_project_member(project uuid)` helper. So: (1) the update/delete RLS policies must use that helper; (2) the version-bump trigger must also add `updated_at` if wanted (add the column in this migration); (3) editing a claim sets `origin = 'founder'` (replace every `author_kind = 'founder'` below); (4) the immutable-column guard covers `project_id` and `block`; (5) S-02 has a `unique (project_id, block, position)` constraint, so new claims need the next free `position` in the block and deletes leave gaps (fine). S-02's canvas page is `src/pages/project/index.astro`, and its claim badge component is `src/components/canvas/ClaimCard.astro`; the editor island replaces/extends those.

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

- [x] 1.1 Migrations apply on a clean DB: `npx supabase db reset` (applied with `stack.sh reset`)
- [x] 1.2 Assertion script passes: `psql ... -f supabase/tests/canvas_conflict_safety.sql` (the script is `supabase/tests/canvas_claims_editing.sql`; 19 mutations, 16 caught, 3 equivalent, see notes; 12 parallel adds: 12 distinct positions, and 5 of 12 collide without the lock)
- [ ] 1.3 DB lint is clean: `npx supabase db lint` (needs Docker; not possible in the sandbox)

#### Manual

- [ ] 1.4 In Studio, updating a claim twice shows `version` going 1 → 2 → 3 and `updated_at` changing (not done: Studio is unavailable here; the revision sequence 1 → 2 → 3 is asserted in SQL, and there is no `updated_at`)

### Phase 2: Claims API

#### Automated

- [x] 2.1 Type checking and lint pass: `npm run lint` (plus `npx astro check` and `npm run test:canvas-edit`, 10 checks, 10 mutations caught)
- [x] 2.2 Production build succeeds: `npm run build`

#### Manual

- [x] 2.3 PATCH with current version returns 200; stale version returns 409 with saved row; unauthenticated returns 401 (smoke, incl. a same-revision race that always gives one 200 and one 409)

### Phase 3: Editor UI

#### Automated

- [x] 3.1 Lint and format pass: `npm run lint && npm run format`
- [x] 3.2 Production build succeeds: `npm run build`

#### Manual

- [x] 3.3 Editing, adding and deleting a claim persists after refresh (Chromium)
- [x] 3.4 Editing an AI-drafted claim changes its badge to founder-authored (Chromium)
- [x] 3.5 Two-tab edit shows the resolver; Keep mine saves, Use saved discards (Chromium)
- [x] 3.6 Two consecutive saves in one tab never conflict with each other (smoke and Chromium)
- [x] 3.7 Keyboard-only operation works for edit, save, cancel and the resolver (Chromium: Enter, Ctrl+Enter, Escape, focus lands on the resolver and returns to Edit)

### Phase 4: Smoke coverage and hardening

#### Automated

- [x] 4.1 Smoke passes against a running server with local Supabase: `npm run smoke` (120 steps)
- [x] 4.2 Lint and build pass: `npm run lint && npm run build`

#### Manual

- [x] 4.3 Phase 3 two-tab checklist re-run against `npm run preview` (Chromium script against the production preview)

### Implementation notes

- **Schema** (`20261001100700_canvas_claims_editing.sql`, additive): UPDATE and DELETE policies through `is_project_member`; the `canvas_claims_guard` BEFORE UPDATE trigger keeps id, project, block, position and `created_at` fixed, bumps `revision` by exactly one when the text changes, sets `origin = 'founder'` on a text change, and leaves a save that changes nothing completely untouched (no bump, same origin), whatever the caller sends; `add_canvas_claim(project, block, text)` (security invoker, per-block advisory lock, next free position = max + 1, cap of 12 per block, returns `{ok, claim}` or `{ok: false, code: 'block_full'}`). No `updated_at` column was added.
- **Pure module** `src/lib/services/canvas-edit.ts`: claim text is one short line (line breaks collapse, 1..280 after trimming), `expectedRevision` must be a positive integer, extra body fields (origin, revision, block, position) are stripped, `toPublicClaim` allow-lists six fields, `statusForClaimCode`.
- **Service** `claims.ts`: `updateClaim` is one conditional UPDATE on `(id, revision)`; zero rows is followed by a read that decides `not_found`, success (the saved text already equals what was sent) or `conflict` carrying the saved claim. `deleteClaim` is revision-checked, a missing claim counts as deleted. `createClaim` resolves the founder's own project server-side (no project id from the client).
- **Routes**: `POST /api/claims`, `PATCH` and `DELETE /api/claims/[id]` (JSON only; 401, 400, 404, 409 `conflict` with `current`, 409 `block_full`, 415).
- **UI**: `/project` renders the island `CanvasEditor` (hook `useClaimEditor`, `ClaimItem`, `AddClaim`, `ConflictResolver`); saves are explicit (Save/Cancel, Escape, Ctrl/Cmd+Enter); Keep mine re-saves against the revision that won, Use saved adopts it; a claim deleted elsewhere offers "Add my wording as a new claim"; delete asks first and says assumptions drawn from the claim keep their wording but lose the link (the S-04 link rows cascade). A founder who prefers to write it all can start from `/project?blank=1`; once claims exist the page always shows the editor, and a canvas emptied by hand offers the AI draft again. The read-only `CanvasBoard.astro` and `ClaimCard.astro` were removed.
- **Verification**: SQL script (19 mutations: 16 caught; the 3 survivors, "project not immutable" and the two "policy open to everyone" variants, are equivalent because an UPDATE or DELETE with a WHERE also needs SELECT visibility and the update policy's WITH CHECK refuses a move to another project); `test:canvas-edit`; 18 new smoke steps (120 total) incl. the race (three rounds of two simultaneous saves: always one 200 and one 409 carrying the winner's text), the stale and repeat delete, parallel adds and the cap, escaped founder text, island props allow-listed, another founder gets 404 and cannot change or delete a claim, and the direct PostgREST edit where the database still owns revision and origin; 9 app-level mutations caught (removing the revision check makes both racing saves return 200); a Chromium script covered edit, Escape, keyboard-only, add, delete with confirmation, the two-tab conflict with both resolutions, deleted-elsewhere, the 280-character counter, no horizontal scroll at 390 px, and the blank canvas.
- **Not verified**: `npx supabase db lint` (needs Docker) and the Studio check (1.4).
