# Data & Workspace Scaffold Implementation Plan

## Overview

Stand up Supabase migration tooling and the minimal tenant schema that FR-004 needs: `workspaces` and `workspace_members`, with a trigger on `auth.users` that creates exactly one personal workspace and one owner membership atomically at signup. This also establishes the migration + RLS pattern that every later slice copies. (Roadmap item F-01.)

## Current State Analysis

- `supabase/` contains only `config.toml`. There is no `migrations/` directory and no `seed.sql`, even though `[db.seed] sql_paths = ["./seed.sql"]` references one (`supabase/config.toml`).
- Signup is a bare `supabase.auth.signUp({ email, password })` in `src/pages/api/auth/signup.ts` with no workspace logic. `src/middleware.ts` only resolves `locals.user`.
- No `src/types.ts` exists, although CLAUDE.md says shared entity types belong there.
- No test runner in `package.json`. CI (`.github/workflows/ci.yml`) runs lint, build, and smoke only.
- `[auth.email] enable_confirmations = false` locally. The email-verification gate (FR-001) is owned by S-01, not this change.
- No `context/foundation/lessons.md` exists.

## Desired End State

After `npx supabase db reset` on a clean local stack:

- Inserting a row into `auth.users` (i.e. any signup) results in exactly one `workspaces` row and exactly one `workspace_members` row with `role = 'owner'` for that user, in the same transaction.
- A second user cannot read or write the first user's workspace or membership via RLS.
- `src/types.ts` exports `Workspace` and `WorkspaceMember` types.
- The SQL assertion script in `supabase/tests/` passes.

### Key Discoveries:

- `supabase/config.toml` `[db.seed]` points at a missing `./seed.sql`; `db reset` should not be left depending on a missing file.
- CLAUDE.md mandates: migration naming `YYYYMMDDHHmmss_short_description.sql`; RLS enabled on every new table; granular per-operation, per-role policies.
- FR-004 forbids any gap where a signed-up founder has no workspace, which rules out app-side creation after `signUp`.

## What We're NOT Doing

- No canvas, project, assumption, or rehearsal tables (introduced by the slices that need them).
- No `profiles` table.
- No changes to `signup.ts`, the middleware, or any auth page.
- No email-verification gate or password reset (S-01).
- No multi-member roles, invitations, or team workspaces (PRD non-goals). `role` has the single value `owner`.
- No CI wiring of the SQL test script.
- No backfill: there are no existing users to migrate.

## Implementation Approach

Two migrations-worth of intent in one file: schema + helper + policies + trigger, so the whole FR-004 contract lands or fails together. Use a `SECURITY DEFINER` trigger function (with a pinned `search_path`) on `auth.users` so the workspace creation is part of the signup transaction. Use a `SECURITY DEFINER` `is_workspace_member()` helper so policies on `workspace_members` don't recurse and later tables reuse one predicate. Verify with a plain SQL assertion script run against the reset local database, so no new dependencies are needed.

## Critical Implementation Details

- **Trigger failure blocks signup.** A bug in the `auth.users` trigger makes every signup fail. The verification script must exercise the trigger on a real `auth.users` insert, and the function must be idempotent-safe (no unhandled exceptions on normal input).
- **RLS recursion.** A policy on `workspace_members` that queries `workspace_members` directly recurses. The `SECURITY DEFINER` helper, owned by a role that bypasses RLS, avoids this.

## Phase 1: Migration tooling baseline

### Overview

Make the Supabase CLI workflow valid on an empty schema: the migrations directory exists and the seed reference resolves.

### Changes Required:

#### 1. Migrations directory and seed file

**File**: `supabase/migrations/.gitkeep`, `supabase/seed.sql`

**Intent**: Create the migrations directory so the CLI and later slices have a home for migrations, and add an empty seed file so `[db.seed]` in `config.toml` resolves.

**Contract**: `supabase/seed.sql` contains only a comment stating that it is intentionally empty. The `.gitkeep` is removed or left once the first migration lands in Phase 2.

### Success Criteria:

#### Automated Verification:

- Local stack resets cleanly with no migrations: `npx supabase db reset`

#### Manual Verification:

- `supabase/migrations/` and `supabase/seed.sql` exist and are tracked.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding to the next phase.

---

## Phase 2: Workspace schema, trigger, and RLS

### Overview

One migration that adds the tenant tables, the membership helper, per-operation RLS policies, and the signup trigger.

### Changes Required:

#### 1. Workspace schema, helper, policies, and trigger

**File**: `supabase/migrations/<timestamp>_workspace_scaffold.sql` (timestamp in `YYYYMMDDHHmmss` format, generated at implementation time)

**Intent**: Create `workspaces` and `workspace_members`, enforce one owner workspace per founder, define the shared membership predicate and RLS policies, and create each founder's workspace + owner membership inside the signup transaction.

**Contract**:

- `public.workspaces(id uuid pk default gen_random_uuid(), name text not null, created_at timestamptz not null default now())`.
- `public.workspace_members(workspace_id uuid references workspaces on delete cascade, user_id uuid references auth.users on delete cascade, role text not null default 'owner' check (role = 'owner'), created_at timestamptz not null default now(), primary key (workspace_id, user_id))`, plus a unique index on `user_id` so a founder has at most one membership in this release.
- RLS enabled on both tables.
- `public.is_workspace_member(ws uuid) returns boolean`, `SECURITY DEFINER`, `STABLE`, with `set search_path = ''`, true when `auth.uid()` has a membership row for `ws`.
- Policies, for role `authenticated` only and one per operation: `SELECT` on `workspaces` and `workspace_members` gated by `is_workspace_member`. `UPDATE` on `workspaces` gated by membership (using + with check). No client `INSERT` or `DELETE` policies on either table in this release: creation happens only through the trigger, and deletion cascades from `auth.users`. No policies for `anon`.
- `public.handle_new_user() returns trigger`, `SECURITY DEFINER`, `set search_path = ''`, inserts the workspace (default name, e.g. "Personal workspace") and the owner membership. Attached as `AFTER INSERT ON auth.users FOR EACH ROW`.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly on a fresh database: `npx supabase db reset`
- No schema drift or lint errors in the new migration: `npx supabase db lint`

#### Manual Verification:

- In Studio, both tables show RLS enabled and the expected policies.
- Signing up a user through the running app (`/auth/signup`) produces one workspace and one owner membership in Studio.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding to the next phase.

---

## Phase 3: Verification script and shared types

### Overview

Make the FR-004 and RLS guarantees repeatable, and give app code its types.

### Changes Required:

#### 1. SQL assertion script

**File**: `supabase/tests/workspace_scaffold.sql`

**Intent**: Prove, against a reset local database, that signup creates exactly one workspace and one owner membership, that a second membership for the same user is rejected, and that RLS isolates two users from each other.

**Contract**: Runs as a single script inside a transaction that is rolled back at the end. It inserts two `auth.users` rows, then asserts counts per user, asserts the unique-membership violation is raised, and, with `set local role authenticated` and `request.jwt.claims` set to each user in turn, asserts each user sees only their own workspace and membership and that cross-user `UPDATE` affects zero rows. Any failed assertion raises an exception so the script exits non-zero when run with `psql -v ON_ERROR_STOP=1`.

#### 2. Shared entity types

**File**: `src/types.ts`

**Intent**: Provide the first shared entity types per CLAUDE.md so S-01 and later slices import rather than redefine them.

**Contract**: Export `Workspace` (`id`, `name`, `created_at`) and `WorkspaceMember` (`workspace_id`, `user_id`, `role: "owner"`, `created_at`).

#### 3. Pattern note for later slices

**File**: `supabase/README.md`

**Intent**: Document in a few lines how to add a migration and the RLS pattern later slices must follow, so the pattern doesn't live only in this plan.

**Contract**: Covers naming format, "enable RLS on every table", per-operation `authenticated` policies using `is_workspace_member(workspace_id)`, and how to run `supabase/tests/*.sql`.

### Success Criteria:

#### Automated Verification:

- Assertion script passes on a reset database: `npx supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/workspace_scaffold.sql`
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Build passes: `npm run build`
- Smoke test still passes: `npm run smoke`

#### Manual Verification:

- `supabase/README.md` is readable and accurate to what was built.
- Signing up two users in the app shows each with their own separate workspace in Studio.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human.

---

## Testing Strategy

### Unit Tests:

- No unit test runner exists, and none is added. The SQL assertion script is the test.

### Integration Tests:

- `supabase/tests/workspace_scaffold.sql`: atomic creation, one-owner constraint, cross-user RLS isolation.
- Existing `npm run smoke` confirms signup still works end to end with the trigger in place.

### Manual Testing Steps:

1. Run `npx supabase start`, then `npx supabase db reset`.
2. Sign up a user at `/auth/signup`; confirm one workspace and one owner membership in Studio.
3. Sign up a second user; confirm they get their own, separate workspace.

## Performance Considerations

None at this scale: one extra two-row insert per signup, and a primary-key lookup in the membership helper.

## Migration Notes

No existing data. Rollback is dropping the trigger, function, policies, and tables in reverse order; since no later slice depends on it yet, `db reset` is sufficient locally.

## References

- Roadmap: `context/foundation/roadmap.md` (F-01)
- PRD: `context/foundation/prd.md` (FR-004)
- Existing signup path: `src/pages/api/auth/signup.ts`
- Supabase config: `supabase/config.toml`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Migration tooling baseline

#### Automated

- [ ] 1.1 Local stack resets cleanly with no migrations: `npx supabase db reset`

#### Manual

- [ ] 1.2 `supabase/migrations/` and `supabase/seed.sql` exist and are tracked

### Phase 2: Workspace schema, trigger, and RLS

#### Automated

- [ ] 2.1 Migration applies cleanly on a fresh database: `npx supabase db reset`
- [ ] 2.2 No schema drift or lint errors in the new migration: `npx supabase db lint`

#### Manual

- [ ] 2.3 In Studio, both tables show RLS enabled and the expected policies
- [ ] 2.4 Signing up a user through the running app produces one workspace and one owner membership in Studio

### Phase 3: Verification script and shared types

#### Automated

- [ ] 3.1 Assertion script passes on a reset database
- [ ] 3.2 Type checking passes: `npx astro check`
- [ ] 3.3 Linting passes: `npm run lint`
- [ ] 3.4 Build passes: `npm run build`
- [ ] 3.5 Smoke test still passes: `npm run smoke`

#### Manual

- [ ] 3.6 `supabase/README.md` is readable and accurate to what was built
- [ ] 3.7 Signing up two users in the app shows each with their own separate workspace in Studio
