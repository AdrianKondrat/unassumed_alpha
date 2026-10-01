# MVP Branch Deploy Pipeline Implementation Plan

## Overview

Pushing to the `mvp` branch should automatically deploy the app to its own Cloudflare Worker (`unassumed-mvp`), after lint, typecheck, build and smoke pass. The deployed environment is isolated from the `unassumed_alpha` main-branch landing page and waitlist (FR-018) and uses a dedicated hosted Supabase project. This is roadmap item F-03.

## Current State Analysis

- `.github/workflows/ci.yml` triggers on push/PR to `master` only. It has two jobs: `ci` (lint, `astro check`, build) and `smoke` (local Supabase, build, preview, `npm run smoke`). There is no deploy step.
- `wrangler.jsonc` is a Workers + static assets config. Its `name` is the starter default `10x-astro-starter`. It is not a Pages config, although the roadmap and `tech-stack.md` say "Cloudflare Pages".
- `astro.config.mjs` uses `@astrojs/cloudflare` (v14). `SUPABASE_URL` and `SUPABASE_KEY` are server secrets (`astro:env/server`, optional), so they must exist as Worker runtime secrets as well as at build time.
- The local folder is not a git repo, so the `mvp` branch, remote and GitHub secrets can't be verified from here.
- No `lessons.md`, frame or research exists for this change.

## Desired End State

A push to `mvp` runs CI, then deploys the Worker `unassumed-mvp`. A post-deploy check confirms the Worker's URL returns HTTP 200. Pushes to other branches never deploy. The main-branch marketing site is untouched, and the required secrets and setup steps are documented.

### Key Discoveries:

- `.github/workflows/ci.yml:3-7`: triggers only on `master`, so `mvp` currently gets no CI at all.
- `wrangler.jsonc:3`: the Worker name `10x-astro-starter` must be changed to avoid colliding with other deployments.
- `astro.config.mjs:18-19`: Supabase vars are runtime secrets, so the deploy must set them on the Worker, not only at build time.
- Roadmap F-03 and `tech-stack.md` say "Pages", but the adapter and `wrangler.jsonc` target Workers. The decision for this plan is Workers.

## What We're NOT Doing

- Cloudflare Pages, per-PR preview deploys, or custom domains.
- Running the full smoke test against the deployed URL, since it would create users in the hosted project.
- Deploying from `master` or any non-`mvp` branch.
- Creating the hosted Supabase project or its schema (F-01 and S-01 own the schema).
- Observability or error tracking (parked in the roadmap).
- Touching the `unassumed_alpha` main-branch landing page or its deploy.

## Implementation Approach

Keep one Worker config and one workflow. Add a `deploy` job gated on both existing jobs and on `push` to `mvp`, using `cloudflare/wrangler-action`. Put the Supabase runtime secrets on the Worker through the action's `secrets` input, so they are never written to the repo. Run a curl-based 200 check after deploy.

## Critical Implementation Details

- **Adapter build output**: with `@astrojs/cloudflare` v14, `astro build` generates the deployable config under `dist/`. Confirm in Phase 1 which command (`wrangler deploy` from root vs. the generated config) deploys correctly, and use that exact command in CI.
- **Build-time secrets**: the deploy job's build step must use the MVP project's `SUPABASE_URL`/`SUPABASE_KEY` repo secrets, as the existing `ci` job does. Don't reuse the local-Supabase values from `smoke`.
- **Branch creation**: the `mvp` branch must exist on the GitHub remote before the first deploy. This folder is not a git repo, so that is a manual step for the user.

## Phase 1: Isolated Worker config

### Overview

Give the MVP deployment its own Worker identity and confirm the adapter build deploys under it.

### Changes Required:

#### 1. Worker identity

**File**: `wrangler.jsonc`

**Intent**: Rename the Worker so the MVP deploy can't collide with or overwrite any other Worker (including the marketing site).

**Contract**: `name` becomes `unassumed-mvp`. All other fields stay unchanged. If the adapter-generated config requires a different deploy invocation, record the verified command in the plan's Progress notes.

### Success Criteria:

#### Automated Verification:

- Production build succeeds: `npm run build`
- Lint passes: `npm run lint`
- Wrangler accepts the config (dry run): `npx wrangler deploy --dry-run`

#### Manual Verification:

- The verified deploy command is recorded for use in Phase 2

**Implementation Note**: After this phase and its automated checks pass, pause for manual confirmation before Phase 2.

---

## Phase 2: CI deploy job

### Overview

Add `mvp` to the workflow triggers and a gated deploy job with a post-deploy check.

### Changes Required:

#### 1. Workflow triggers

**File**: `.github/workflows/ci.yml`

**Intent**: Run CI and smoke on `mvp` as well as `master`, so the deploy gate has something to depend on.

**Contract**: `on.push.branches` and `on.pull_request.branches` become `[master, mvp]`.

#### 2. Deploy job

**File**: `.github/workflows/ci.yml`

**Intent**: Deploy the built Worker to Cloudflare, only on a push to `mvp` and only after `ci` and `smoke` succeed, then verify it responds.

**Contract**: New job `deploy` with `needs: [ci, smoke]` and `if: github.event_name == 'push' && github.ref == 'refs/heads/mvp'`. Steps are: checkout, setup-node 22, `npm ci`, `npm run build` (env `SUPABASE_URL`/`SUPABASE_KEY` from repo secrets), then `cloudflare/wrangler-action` with `apiToken: CLOUDFLARE_API_TOKEN`, `accountId: CLOUDFLARE_ACCOUNT_ID`, the deploy command verified in Phase 1, and `secrets` set to `SUPABASE_URL` and `SUPABASE_KEY` (passed through `env`). The final step curls the deployed URL (the action's `deployment-url` output) and fails unless the response is HTTP 200. The job sets `concurrency: deploy-mvp` with `cancel-in-progress: false` so deploys don't overlap.

### Success Criteria:

#### Automated Verification:

- Workflow YAML is valid: `npx --yes yaml-lint .github/workflows/ci.yml` (or `actionlint` if available)
- Prettier formatting: `npx prettier --check .github/workflows/ci.yml`
- Lint, typecheck and build still pass: `npm run lint && npx astro check && npm run build`

#### Manual Verification:

- A push to `master` or a PR does not trigger the `deploy` job
- A failing `ci` or `smoke` job prevents `deploy` from running

**Implementation Note**: After this phase, pause for manual confirmation before Phase 3.

---

## Phase 3: Docs, secrets runbook and first deploy

### Overview

Make the setup repeatable, fix the Pages wording, and prove the pipeline end to end.

### Changes Required:

#### 1. Secrets and setup runbook

**File**: `README.md`

**Intent**: Document the one-time setup so the pipeline can be reproduced.

**Contract**: A short "MVP deploy" section listing the `mvp` branch, the required GitHub repo secrets (`CLOUDFLARE_API_TOKEN` with Workers edit permission, `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_URL`, `SUPABASE_KEY` for the hosted MVP project), the Worker name `unassumed-mvp`, and the fact that only pushes to `mvp` deploy.

#### 2. Correct deploy-target wording

**Files**: `context/foundation/roadmap.md`, `context/foundation/tech-stack.md`

**Intent**: Replace "Cloudflare Pages" with "Cloudflare Workers" for the MVP deployment so later slices plan against the real target.

**Contract**: Wording edits in F-03 and the Backlog Handoff row of the roadmap, and in the `deployment_target` and rationale text of `tech-stack.md`. No other content changes.

#### 3. Roadmap status

**File**: `context/foundation/roadmap.md`

**Intent**: Mark F-03 as done once the first deploy is verified.

**Contract**: F-03 status moves to `done` in the At a glance table and the F-03 section, and the item is listed under `## Done`.

### Success Criteria:

#### Automated Verification:

- Formatting passes: `npx prettier --check README.md context/foundation/roadmap.md context/foundation/tech-stack.md`
- No stale references remain: `grep -n "Pages" context/foundation/roadmap.md context/foundation/tech-stack.md` returns no deployment-target mentions

#### Manual Verification:

- `mvp` branch exists on GitHub and the four secrets are configured
- A push to `mvp` runs the full pipeline and the Worker `unassumed-mvp` appears in the Cloudflare dashboard
- The deployed workers.dev URL loads the app, and the post-deploy check passed in the Actions log
- The `unassumed_alpha` main-branch landing page and waitlist are unaffected

---

## Testing Strategy

### Unit Tests:

- None. This change is configuration and CI only.

### Integration Tests:

- The existing `ci` and `smoke` jobs run unchanged on `mvp`. The new post-deploy HTTP check is the deploy-level test.

### Manual Testing Steps:

1. Push a trivial commit to `mvp` and watch the Actions run through ci, smoke and deploy.
2. Open the deployed URL and confirm the landing/auth pages render.
3. Push a commit to `master` (or open a PR) and confirm no deploy runs.
4. Break lint on a throwaway commit to `mvp` and confirm deploy is skipped.

## Performance Considerations

None. The smoke job adds roughly a few minutes to each deploy, which is accepted in exchange for gating.

## Migration Notes

None. The environment is pre-launch with no live data. Rollback is re-deploying a previous commit, or `wrangler rollback` for the Worker.

## References

- Roadmap item: `context/foundation/roadmap.md` (F-03)
- PRD guardrail: `context/foundation/prd.md` (FR-018)
- Existing CI: `.github/workflows/ci.yml:1-54`
- Worker config: `wrangler.jsonc`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Isolated Worker config

#### Automated

- [ ] 1.1 Production build succeeds: `npm run build`
- [ ] 1.2 Lint passes: `npm run lint`
- [ ] 1.3 Wrangler accepts the config (dry run): `npx wrangler deploy --dry-run`

#### Manual

- [ ] 1.4 The verified deploy command is recorded for use in Phase 2

### Phase 2: CI deploy job

#### Automated

- [ ] 2.1 Workflow YAML is valid
- [ ] 2.2 Prettier formatting passes for the workflow
- [ ] 2.3 Lint, typecheck and build still pass

#### Manual

- [ ] 2.4 A push to `master` or a PR does not trigger the `deploy` job
- [ ] 2.5 A failing `ci` or `smoke` job prevents `deploy` from running

### Phase 3: Docs, secrets runbook and first deploy

#### Automated

- [ ] 3.1 Formatting passes for README and foundation docs
- [ ] 3.2 No stale "Pages" deployment-target references remain

#### Manual

- [ ] 3.3 `mvp` branch exists on GitHub and the four secrets are configured
- [ ] 3.4 A push to `mvp` runs the full pipeline and the Worker `unassumed-mvp` appears in Cloudflare
- [ ] 3.5 The deployed workers.dev URL loads the app and the post-deploy check passed
- [ ] 3.6 The `unassumed_alpha` main-branch landing page and waitlist are unaffected
