# Manual Canvas Editing with Conflict Safety — Plan Brief

> Full plan: `context/changes/manual-canvas-editing-with-conflict-safety/plan.md`

## What & Why

Let founders edit, add and delete canvas claims by hand (FR-007), with a guarantee that two racing edits never silently overwrite each other (FR-008). This is roadmap slice S-03. It is cheap insurance against silent data loss and keeps founders in control of an AI-drafted canvas.

## Starting Point

No canvas code or tables exist. F-01 (workspace schema and RLS pattern) and S-01 are planned but unbuilt, and S-02, which creates the canvas, has no plan yet. The only app data path today is auth form → API route → redirect.

## Desired End State

On the canvas page a founder can edit, add and delete claims. A save from a stale version never overwrites: they see "your edit" beside "saved version" and choose Keep mine or Use saved. A manual edit marks the claim founder-authored.

## Key Decisions Made

| Decision             | Choice                                                                  | Why (1 sentence)                                              |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| S-02 dependency      | Plan against a stated minimal `canvas_claims` contract                  | Unblocks planning without serializing S-03 behind S-02.       |
| Conflict granularity | Per-claim integer version                                               | Edits to different claims never falsely conflict.             |
| Detection mechanism  | Version-checked `UPDATE`/`DELETE` plus a DB trigger bumping the version | Atomic in one statement, no locks, and unskippable.           |
| Conflict UX          | Inline side-by-side, Keep mine / Use saved                              | No lost work, one small component.                            |
| Authorship           | Manual text edit flips `author_kind` to `founder`                       | Marks "founder reviewed and owns it" honestly.                |
| Edit scope           | Edit, add, delete; fixed 9 blocks; no reorder                           | Covers FR-007 without drag UI, given the capacity constraint. |
| Testing              | SQL assertion script plus smoke race case; no new test runner           | Covers the FR-008 guarantee with zero new dependencies.       |

## Scope

**In scope:** write RLS and version trigger, claims API with 409 handling, editor island with conflict resolver, SQL and smoke tests.

**Out of scope:** AI drafting/edits, reordering, auto-merge, locking or real-time sync, edit history, S-02's tables and canvas page.

## Architecture / Approach

Optimistic concurrency per claim. The client loads a claim with its version and sends it back on each write. The DB trigger forces `version + 1`; the API turns zero affected rows into a 409 carrying the current row; the React hook shows the resolver and re-saves against the new version.

## Phases at a Glance

| Phase                | What it delivers                                       | Key risk                                            |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| 1. DB write rules    | Update/delete policies, version trigger, SQL race test | S-02's schema may differ from the assumed contract. |
| 2. Claims API        | Zod-validated POST/PATCH/DELETE with 409 + current row | Distinguishing conflict from "deleted elsewhere".   |
| 3. Editor UI         | Inline editing, badges, ConflictResolver               | Stale version reuse causing self-conflicts.         |
| 4. Smoke + hardening | Concurrent-PATCH case in CI, two-tab check             | Needs S-01/S-02 fixtures in the smoke flow.         |

**Prerequisites:** F-01, S-01 and S-02 implemented; Docker for local Supabase.
**Estimated effort:** ~2 sessions across 4 phases.

## Open Risks & Assumptions

- The S-02 contract (table, columns, block keys, canvas page) is assumed; reconcile when S-02 is planned.
- Smoke assumes S-01/S-02 give the test user a workspace and project to write claims into.
- Dropping the "originally AI-drafted" history on edit is accepted for this release.

## Success Criteria (Summary)

- Two racing saves on one claim yield one accepted update and one visible conflict, never silent loss.
- Founders can edit, add and delete claims and see AI vs founder authorship correctly.
- The guarantee is covered by SQL and smoke checks in CI.
