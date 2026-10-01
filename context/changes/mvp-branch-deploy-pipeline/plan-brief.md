# MVP Branch Deploy Pipeline — Plan Brief

> Full plan: `context/changes/mvp-branch-deploy-pipeline/plan.md`
> Roadmap item: `context/foundation/roadmap.md` (F-03)

## What & Why

Pushing to the `mvp` branch should automatically deploy the app to its own Cloudflare Worker. Today CI only lints, builds and smoke-tests, so nothing can reach the founder or testers for market feedback. The deploy must stay isolated from the live landing page and waitlist (FR-018).

## Starting Point

`ci.yml` runs on `master` only, with no deploy job. `wrangler.jsonc` is a Workers + static assets config still named `10x-astro-starter`. The roadmap says "Pages", but the adapter targets Workers.

## Desired End State

A push to `mvp` runs ci and smoke, then deploys the Worker `unassumed-mvp` and confirms it returns HTTP 200. No other branch deploys. The setup is documented and the main marketing site is untouched.

## Key Decisions Made

| Decision      | Choice                          | Why                                                            |
| ------------- | ------------------------------- | -------------------------------------------------------------- |
| Deploy target | Cloudflare Workers (`wrangler`) | Matches the adapter and `wrangler.jsonc`; fits later Workflows |
| Branch        | `mvp`, deploy on push only      | Simple rule; PRs get CI but never deploy                       |
| Gating        | Deploy needs `ci` + `smoke`     | A broken build never reaches testers                           |
| Supabase      | Dedicated hosted MVP project    | Isolates MVP data from the waitlist (FR-018)                   |
| Verification  | Post-deploy HTTP 200 check      | Cheap; avoids creating test users in the hosted project        |

## Scope

**In scope:** Worker rename, workflow trigger and deploy job, runtime secrets, README runbook, correcting "Pages" wording, roadmap status.

**Out of scope:** Cloudflare Pages, PR previews, custom domains, creating the Supabase project or schema, observability, anything on the main-branch marketing site.

## Architecture / Approach

One workflow, one Worker. A `deploy` job (`needs: [ci, smoke]`, push to `mvp` only) builds with the MVP Supabase secrets, deploys with `cloudflare/wrangler-action` (also setting the Worker runtime secrets), then curls the deployment URL.

## Phases at a Glance

| Phase                          | What it delivers                                           | Key risk                                                 |
| ------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| 1. Isolated Worker config      | Worker renamed to `unassumed-mvp`; deploy command verified | Adapter v14 may need a different deploy invocation       |
| 2. CI deploy job               | Gated deploy job and post-deploy check                     | Secrets misconfigured; deploy triggering on wrong events |
| 3. Docs, secrets, first deploy | Runbook, corrected wording, a verified live deploy         | Manual prerequisites (branch, secrets) not yet in place  |

**Prerequisites:** `mvp` branch on GitHub, Cloudflare API token and account ID, a hosted Supabase project (all manual, none visible from this folder, which isn't a git repo).
**Estimated effort:** ~1-2 short sessions across 3 phases.

## Open Risks & Assumptions

- Assumes a hosted MVP Supabase project will exist before the first deploy.
- The deploy command for the adapter's build output is confirmed only in Phase 1.
- Assumes the marketing site deploys separately and is not affected by this workflow.

## Success Criteria (Summary)

- A push to `mvp` produces a live `unassumed-mvp` Worker without manual steps.
- Pushes to other branches and failing checks never deploy.
- The main-branch landing page and waitlist are unchanged.
