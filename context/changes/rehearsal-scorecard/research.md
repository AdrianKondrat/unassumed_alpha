---
date: 2026-10-01T14:38:57+0100
researcher: Claude (for adriankondrat)
git_commit: n/a (not a git repository)
branch: n/a
repository: MVP (Unassumed)
topic: "Rehearsal scorecard (S-06): can scoring meet the ≤30s NFR synchronously on Cloudflare Workers, and what does the slice build on?"
tags: [research, codebase, rehearsal-scorecard, cloudflare-workers, ai-provider, scoring]
status: complete
last_updated: 2026-10-01
last_updated_by: Claude
---

# Research: Rehearsal scorecard (S-06) — scoring execution model and foundations

**Date**: 2026-10-01T14:38:57+0100
**Repository**: MVP (Unassumed); not under git, so no commit/branch recorded.

## Research Question

Roadmap S-06 is blocked on one Unknown (`roadmap.md:177`, `:211`): can scoring of up to 10 founder turns finish within Cloudflare Workers' limits synchronously to hit the PRD's ≤30s scorecard NFR, or does it need a Workflow/queue? Secondary: what exists in the codebase and prior plans that the scorecard slice builds on, and which constraints shape it?

## Summary

- **Synchronous scoring is feasible; no Workflow/Queue is needed for the 30s NFR**, provided the Worker is on the **Paid plan** and the LLM calls are batched or run in parallel. Time waiting on outbound `fetch()` does not count as CPU, and HTTP-triggered requests have no hard wall-clock limit while the client is connected (Cloudflare limits docs). Workflows/Queues are only warranted for durability/guaranteed completion.
- **The F-02 plan as written can break the NFR**: the `score` task has a 25s timeout with one retry after ~500ms, so worst case is ~50s. S-06 must set its own tighter timeouts (or a deadline across attempts).
- **Deployment is a Worker, not Pages** (`wrangler.jsonc`), contradicting roadmap wording for F-03. Workflows/Queues/DO bindings are available but need a custom entrypoint.
- **Almost nothing is implemented.** No `src/lib/ai.ts`, no migrations, no rehearsal tables, no OpenRouter key. Everything S-06 depends on (F-02, S-04, S-05) is plan-only or a stub, so S-06 cannot be built yet regardless of the Unknown.
- **Scorecard schema, prompt, output JSON, model, session state machine are all undecided** and must be designed in S-06's plan.

## Detailed Findings

### Cloudflare execution limits (sub-agent; docs fetched via summarizing model, spot-check before relying on them)

- CPU per HTTP request: Free 10 ms; Paid default 30 s, configurable to 5 min. Outbound fetch wait is not CPU. Source: https://developers.cloudflare.com/workers/platform/limits/
- Subrequests: Free 50, Paid 10,000. At most **6 simultaneous connections** waiting for response headers per invocation, so 10 parallel LLM calls queue into ~2 waves (docs statement, untested).
- `waitUntil`: up to 30s after response/disconnect, budget shared, unsettled promises cancelled; docs point to Queues beyond that. https://developers.cloudflare.com/workers/runtime-apis/context/
- Workflows: Free has 10 ms CPU/step, Paid 30 s/step. Queues on Free: 10k ops/day, 24h retention.
- Plan tier is not stated anywhere in the repo. Free's 10 ms CPU is risky even for JSON handling and Supabase calls (inference), so treat Paid as required for the scoring route.

### Deployment and bindings

- `wrangler.jsonc:3-11` is a Worker (`main`: adapter entrypoint, `assets` binding `ASSETS`), no Pages settings, no other bindings, no `vars`, no `triggers`. `astro.config.mjs:16` uses `cloudflare()`; `@astrojs/cloudflare ^14.3.1`, `wrangler ^4.131.1`. Astro docs say Pages support was removed from the adapter.
- `roadmap.md:34,95,199` and `tech-stack.md` say "Cloudflare Pages". This is inconsistent with the repo and matters for F-03.
- In API routes `ctx.waitUntil` is `context.locals.cfContext.waitUntil`; secrets via `astro:env/server` (add to `env.schema`, `astro.config.mjs:17-21`).
- Workflows/DO/queue consumers need a custom entrypoint (`main: ./src/worker.ts`, import `handle` from `@astrojs/cloudflare/handler`). Docs show DO and queue examples; a `WorkflowEntrypoint` export with adapter v14 is **unverified**.

### Options for meeting 30s (agent recommendation, not yet measured)

1. **Parallel per-turn calls in the POST handler** (cap ~6, small model, low `max_tokens`, per-call timeout ~15s, one retry): est. 6–10s total.
2. **One batched call over the whole transcript** returning a JSON array: one subrequest, est. 5–15s, but a failure or invalid JSON means a full redo and per-turn accuracy may drop. Hybrid: 3–5 turns per call.
3. **Pending-scorecard row + polling**: POST inserts `pending` row, `waitUntil(score())` updates it, client polls. Only safe if work reliably finishes within the 30s `waitUntil` budget; evictions lose work.
4. **Queue/Workflow per-turn steps** for guaranteed completion; adds entrypoint complexity.

Latency figures are estimates; **OpenRouter p95 with ~10 parallel calls has not been measured.**

### F-02 AI call path (planned, not coded) — `context/changes/ai-provider-integration/plan.md`

- New `src/lib/ai.ts` (:150): `complete({ taskKind, messages, supabase, founderId, overrideModel? }): Promise<AIResult>` (:196-202); `AITaskKind` includes `"score"` (:157); result is typed ok/error with kinds timeout/rate_limited/provider_error/invalid_response (:192-194).
- `TASK_CONFIG` (:159-164): all kinds `openai/gpt-4o-mini` placeholder; timeouts draft 15s, suggest 15s, converse 10s, **score 25s**. Retry once after ~500ms on timeout/429/5xx (:205).
- Pure `buildOpenRouterRequest` always sets `provider: { data_collection: "deny" }`, guarded by a test (:175, :53, :237).
- Returns raw text only; no structured output/`response_format`. Slices own parsing (:43). Pattern to copy: `ai-drafted-canvas-from-brief/plan.md:128-132` (prompt builder + zod schema + `parseDraft` stripping fences, dependency-free module tested with `node --experimental-strip-types`). `zod` is not yet in `package.json`.
- Usage: each successful call inserts an `ai_usage_events` row (:205); failed insert only logged. Queue/background infra and cost guards are explicitly out of F-02 (:38-43).
- F-02 itself says S-06 must verify the NFR with its chosen model (:288).

### Data model and conventions

- No rehearsal session/turn/scorecard tables are designed anywhere (S-05 and S-06 `change.md` are stubs). Roadmap says domain tables are introduced in the first slice that needs them (`roadmap.md:69`).
- Planned: `workspaces`, `workspace_members`, `is_workspace_member()` SECURITY DEFINER with pinned `search_path` (F-01 plan :96-101); `ai_usage_events` keyed by `founder_id` (F-02 :116); `projects`, `canvas_claims` with a `draft_started_at` 60s lease (S-02 :72-74, :52), a possible pattern for a "scoring in progress" claim.
- Conventions: `supabase/migrations/YYYYMMDDHHmmss_*.sql`, RLS on every table with per-operation `authenticated` policies, server-written rows get no client INSERT policy, SQL tests in `supabase/tests/*.sql`.

### Implemented vs planned

Only the starter exists: auth pages/routes, `middleware.ts`, `src/lib/supabase.ts`, one shadcn button, `scripts/smoke.mjs`. `supabase/` has only `config.toml`. All plan checklists are unchecked.

### Constraints on the scorecard

- Never state/imply "validated", "proven" or equivalent (PRD guardrail, US-01). Precedent: S-02 prompt forbids the words and the parser rejects output containing them (S-02 plan :53, :132, :148). Apply to rewrite suggestions and all model prose.
- Visible "beta scoring, may miss nuance" disclaimer (FR-015).
- Five labels: leading, hypothetical, solution-biased, past-behavior, specificity; each flag cites exact quoted turn text and its position; at least one concrete rewrite (FR-015/016, US-01).
- Zero founder turns → "not enough transcript" state, no assessment.
- Persona scenario details must never reach SSR props, API responses or telemetry.
- Calls must go through `complete()` with `taskKind: "score"` so data-collection denial and usage recording apply.
- Secondary success criterion: before/after or trend across rehearsals; no cross-founder benchmarking.

## Code References

- `wrangler.jsonc:3-11` — Worker config with `ASSETS` only
- `astro.config.mjs:16-21` — cloudflare adapter, env schema
- `context/foundation/roadmap.md:177,211` — the blocking Unknown
- `context/changes/ai-provider-integration/plan.md:150-237` — planned `ai.ts`
- `context/changes/ai-drafted-canvas-from-brief/plan.md:128-148` — parse/validate and banned-word pattern
- `context/foundation/prd.md:59-70,115-118` — US-01 and FR-015/016

## Architecture Insights

- The scoring step is classification over a small, capped input (≤10 turns), well within edge limits; the real risks are provider latency/failures, retry budget, and the 6-connection fan-out limit, not Workers' wall-clock.
- A pending-row state on the session/scorecard makes both sync and async designs viable and also supports refresh/resume (FR-017, S-07). Deciding that state machine in S-06 plan avoids rework.
- Per-turn validation of output (zod + banned-word rejection + verbatim quote check against the stored turn) is a natural way to guarantee "exact quoted turns".

## Historical Context (from prior changes)

- `context/changes/ai-provider-integration/plan.md` and `plan-brief.md` — call path and score timeout that this slice inherits
- `context/changes/ai-drafted-canvas-from-brief/plan.md` — synchronous, no-queue precedent with a Workflow noted as later fallback (:42, :291)
- `context/foundation/stack-assessment.md` covers the marketing repo, not this app; its vitest suggestion conflicts with the plans' Node-script test convention.

## Related Research

None yet under `context/changes/**/research.md`.

## Open Questions

1. Workers plan tier (Paid required for the scoring route in practice) — owner: founder. Nothing in the repo records it.
2. Measured OpenRouter p95 latency and rate limits for ~10 concurrent classification calls with the chosen model.
3. Which model scores (Roadmap Open Question 1), and batched vs per-turn calls (accuracy vs latency).
4. Retry budget: reconcile F-02's 25s timeout + retry with a 30s end-to-end NFR (shared deadline, shorter per-call timeout).
5. Failure UX when scoring fails after a session ends (retry button? pending state?) and interaction with S-07 resume.
6. Scorecard and session/turn schema; the persona-turn storage S-05 will define.
7. Roadmap/tech-stack say "Pages" while the repo is a Worker; fix before F-03.
8. Spot-check key Cloudflare numbers (10 ms free CPU, 30s waitUntil, 6 connections) against the doc pages; the fetch results came through a summarizing model.
