# AI Provider Integration — Plan Brief

> Full plan: `context/changes/ai-provider-integration/plan.md`

## What & Why

Wire a reusable, server-only call path to OpenRouter that every future AI-touching slice (canvas drafting, assumption suggestion, rehearsal persona, scoring) builds on. This is a Foundation (`F-02` in the roadmap) — it exists because four very different future features all need the same privacy-safe, retriable, usage-tracked way to call an AI model, and getting that pattern right once now is cheaper than four separate retrofits later.

## Starting Point

The codebase (freshly scaffolded from `10x-astro-starter`) has no AI integration at all today — no SDK, no env var, no client module. What it does have is a clean pattern to mirror: `src/lib/supabase.ts` + `astro.config.mjs`'s env schema for secrets, and `scripts/smoke.mjs` as the zero-dependency testing convention (no vitest/jest installed).

## Desired End State

Any server-side route can call `complete({ taskKind, messages, supabase, founderId })` from `src/lib/ai.ts` and get back a typed result — success with text + token usage, or a typed failure — without worrying about retries, timeouts, the privacy opt-out, or usage logging; those are all handled once, inside `complete()`.

## Key Decisions Made

| Decision                | Choice                                                                          | Why (1 sentence)                                                                                      | Source                |
| ----------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------- |
| Model config shape      | Per-task-kind slot, same default model for now                                  | Future slices can tune their model without touching the shared client, at zero extra cost today       | Plan (user-confirmed) |
| Failure handling        | One retry with backoff, then typed error                                        | Fits the PRD's latency NFRs while giving every slice one consistent failure signal                    | Plan (user-confirmed) |
| Timeouts                | Per-task-kind defaults (15s draft/suggest, 10s converse, 25s score)             | Matches the PRD's differentiated NFRs instead of one-size-fits-all                                    | Plan (user-confirmed) |
| Usage tracking          | Minimal ledger table now, written automatically on every successful call        | PRD Non-Goals explicitly requires usage recording even without billing enforcement                    | Plan (user-confirmed) |
| Privacy NFR enforcement | `provider.data_collection: "deny"` on every request + a unit test asserting it  | Satisfies "never used for training" at the request level, with a regression guardrail                 | Plan (user-confirmed) |
| Secret storage          | Mirror the Supabase `astro:env/server` pattern exactly                          | Zero new patterns, already proven in this repo's CI                                                   | Plan (user-confirmed) |
| Cost guard              | None in this foundation — deferred                                              | Honors the capacity constraint; the turn cap and the billing non-goal already bound cost structurally | Plan (user-confirmed) |
| Usage-ledger key        | `auth.users.id`, not `workspace_id`                                             | Avoids a silent cross-foundation dependency on `F-01`, which this change doesn't need to wait for     | Plan                  |
| Test approach           | Zero-dependency script testing the pure request-builder, no live API call in CI | Matches the existing `smoke.mjs` convention; avoids real API cost/flakiness in CI                     | Plan                  |

## Scope

**In scope:** per-task model/timeout config, request builder with the privacy opt-out, retry-once logic, typed result, usage-ledger migration + automatic recording, a unit test, CI/secret wiring.

**Out of scope:** the actual drafting/suggestion/persona/scoring prompts (belong to `S-02`/`S-04`/`S-05`/`S-06`), background-job/queue infrastructure, rate-limiting, usage-data UI, live API calls in CI.

## Architecture / Approach

One new module, `src/lib/ai.ts`, exposing `complete()`. It mirrors `src/lib/supabase.ts`'s secret-reading pattern, calls OpenRouter's chat-completions endpoint directly via `fetch` (no new dependency), and on success writes one row to a new `ai_usage_events` table via the caller's own Supabase client (RLS-scoped to that founder).

## Phases at a Glance

| Phase                             | What it delivers                                                | Key risk                                                                                   |
| --------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1. Secrets & environment plumbing | `OPENROUTER_API_KEY` wired through local/CI/Cloudflare          | Forgetting the Cloudflare dashboard secret (manual, outside the repo)                      |
| 2. Usage ledger migration         | `ai_usage_events` table + RLS                                   | `supabase/migrations/` may not exist yet depending on `F-01`'s status                      |
| 3. AI client module               | `complete()` with retry, timeout, privacy flag, usage recording | Getting the request-builder's privacy flag genuinely load-bearing, not just set-and-forget |
| 4. Automated verification         | `npm run test:ai` + CI step                                     | None significant — pure-function test, no network dependency                               |

**Prerequisites:** none (this is a Foundation with no Prerequisites in the roadmap).
**Estimated effort:** a few focused sessions across 4 phases — small relative to the slices it unlocks.

## Open Risks & Assumptions

- The default model (`openai/gpt-4o-mini`) is a placeholder for a cost-effective, generally-capable OpenRouter model — confirm current availability/pricing at implementation time.
- Hitting the PRD's actual latency NFRs (p95 < 8s for chat turns, ≤30s for scorecards) depends on the model each consuming slice ultimately picks, not just this foundation's timeout plumbing — flagged for those slices' own plans to verify.
- If `npm run test:ai` can't cleanly import `src/lib/ai.ts` as plain ESM (TypeScript resolution), the CI step may need to run after `npm run build` against compiled output instead — a small implementation-time judgment call, not a design change.

## Success Criteria (Summary)

- `complete()` is callable from any server-side route and returns a typed result with text + usage.
- Every outgoing request provably carries the privacy opt-out (enforced by a test that fails if it's removed).
- Every successful call produces exactly one `ai_usage_events` row, visible only to the calling founder.
