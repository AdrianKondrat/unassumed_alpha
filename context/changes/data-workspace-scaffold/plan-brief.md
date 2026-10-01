# Data & Workspace Scaffold — Plan Brief

> Full plan: `context/changes/data-workspace-scaffold/plan.md`

## What & Why

Stand up Supabase migration tooling and the minimal tenant schema FR-004 needs: every founder gets exactly one personal workspace and one owner membership, atomically at signup. This is roadmap foundation F-01. It unblocks S-01 and sets the migration + RLS pattern every later slice copies.

## Starting Point

`supabase/` has only `config.toml`: no migrations directory, and the `seed.sql` it references doesn't exist. Signup is a bare `auth.signUp` call with no workspace logic, and there is no `src/types.ts`.

## Desired End State

After `npx supabase db reset`, signing up any user produces one workspace and one owner membership in the same transaction. A second user cannot see or change the first user's rows. A repeatable SQL script proves both, and `src/types.ts` exports the entity types.

## Key Decisions Made

| Decision     | Choice                                              | Why (1 sentence)                                                              |
| ------------ | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| Atomicity    | `SECURITY DEFINER` trigger on `auth.users`          | Truly atomic with signup, so there is no gap and no app path can skip it.     |
| Schema shape | `workspaces` + `workspace_members` (role = `owner`) | Matches FR-004's wording and gives later slices a stable tenant key.          |
| RLS pattern  | `is_workspace_member()` helper + per-op policies    | One reusable predicate that avoids recursive policies on `workspace_members`. |
| Verification | `db reset` + SQL assertion script                   | Repeatable, no new dependencies, covers atomicity and RLS isolation.          |
| App code     | No changes to signup or middleware                  | The trigger makes workspace creation invisible to the app.                    |
| `profiles`   | Not created                                         | Nothing in this release's PRD needs it yet.                                   |

## Scope

**In scope:** migrations dir + empty seed, workspace schema/trigger/RLS migration, SQL assertion script, `src/types.ts`, `supabase/README.md` pattern note.

**Out of scope:** canvas/assumption/rehearsal tables, profiles, auth page changes, email verification, password reset, teams/roles, CI wiring of the SQL test.

## Architecture / Approach

One migration holds both tables, a one-owner-per-user unique index, the membership helper, `authenticated`-only per-operation policies, and an `AFTER INSERT` trigger on `auth.users` that inserts the workspace and owner membership. Clients get no insert or delete policies, so creation is only via the trigger. Verification runs as a rolled-back SQL script against the reset local DB.

## Phases at a Glance

| Phase                             | What it delivers                                      | Key risk                                    |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| 1. Migration tooling baseline     | `migrations/` dir, empty `seed.sql`, clean `db reset` | Low                                         |
| 2. Workspace schema, trigger, RLS | The FR-004 contract in one migration                  | A trigger bug would block all signups       |
| 3. Verification script and types  | SQL assertions, `src/types.ts`, `supabase/README.md`  | Needs Docker locally; not yet wired into CI |

**Prerequisites:** Docker for `npx supabase start`.
**Estimated effort:** ~1 session across 3 small phases.

## Open Risks & Assumptions

- Trigger failures surface as signup failures, so the script must test a real `auth.users` insert.
- Assumes no existing users need backfilling (the schema is new).
- Assumes `supabase db lint` is available in the pinned CLI version (`supabase ^2.23.4`).

## Success Criteria (Summary)

- A new signup always has exactly one workspace and one owner membership.
- Users are isolated from each other by RLS.
- Later slices have a documented, tested pattern to copy.
