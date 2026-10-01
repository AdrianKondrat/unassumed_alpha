# AI Provider Integration Implementation Plan

## Overview

Wire a reusable, server-only AI-provider call path through OpenRouter that every future AI-touching slice (canvas drafting, assumption suggestion, rehearsal persona, scoring) will build on. This is a Foundation (`F-02` in `context/foundation/roadmap.md`) — it establishes the call path, privacy enforcement, and usage recording; it does not implement any of the actual drafting/suggestion/persona/scoring prompts themselves.

## Current State Analysis

The codebase (freshly scaffolded from `10x-astro-starter`) has no AI provider integration at all today — no AI SDK dependency, no `src/lib/ai.ts`, no AI-related env vars. What exists is a proven pattern for exactly this kind of integration:

- `src/lib/supabase.ts` reads secrets via `astro:env/server` and exposes a factory function that returns `null` if the secret is missing.
- `astro.config.mjs`'s `env.schema` declares each secret as `envField.string({ context: "server", access: "secret", optional: true })`.
- `.github/workflows/ci.yml`'s `ci` job injects secrets from GitHub Actions secrets into the build env, matching the schema.
- No test framework (vitest/jest) is installed. The only testing precedent is `scripts/smoke.mjs` — a zero-dependency plain-Node script invoked via `npm run smoke` and wired into CI's `smoke` job.
- `supabase/migrations/` does not exist yet — no table has ever been created in this project.
- `auth.users` (Supabase's built-in auth table) already exists and is populated today via the starter's working signup flow — this is available as a foreign-key target without needing any other foundation to land first.

## Desired End State

A `complete()` function in `src/lib/ai.ts` that any server-side Astro API route can call to get a model response from OpenRouter, with:

- A per-task-kind model and timeout configuration (one shared default model across all task kinds for now; each kind's model is independently overridable later without touching call sites).
- OpenRouter's zero-data-retention request flag set on every call, satisfying the PRD's "founder content never used for training or retained beyond the request" NFR.
- One retry with backoff on timeout/rate-limit/server-error, then a typed failure result.
- Automatic usage-event recording on every successful call, scoped to the calling founder via RLS.

Verification: `npm run test:ai` passes (confirms every built request carries the privacy opt-out and resolves the correct per-task model); `npm run build` and CI remain green with the new env var wired; a manual `complete()` call against the real OpenRouter API (using a real key in local dev) returns a successful result and produces one row in `ai_usage_events`.

### Key Discoveries:

- Secret-handling convention: `astro.config.mjs:17-22` + `src/lib/supabase.ts:1-21` — mirror exactly for `OPENROUTER_API_KEY`.
- No test framework exists; `scripts/smoke.mjs` is the established zero-dependency testing convention — follow it rather than adding vitest/jest.
- `F-01` (data/workspace scaffold) and this change are marked `Parallel with` each other in the roadmap — keying the usage-ledger table on `workspace_id` would silently introduce a cross-foundation dependency the roadmap never captured. Keying on `auth.users.id` (already present) avoids this.
- OpenRouter's chat-completions endpoint accepts a `provider: { data_collection: "deny" }` field in the request body that restricts routing to zero-data-retention providers — this is the concrete mechanism that satisfies the privacy NFR, and it's a pure, testable property of the request body (no live API call needed to verify it's present).

## What We're NOT Doing

- No actual prompts or business logic for canvas drafting, assumption suggestion, persona conversation, or scoring — those belong to `S-02`, `S-04`, `S-05`, and `S-06` respectively.
- No queue/background-job infrastructure (e.g. Cloudflare Workflows) — deferred; it's an open, non-blocking-for-this-foundation question owned by `S-06`'s own plan.
- No rate-limiting or call-volume guard — explicitly deferred; `S-05`'s turn cap already structurally bounds cost, and billing/plan enforcement is an explicit PRD non-goal this release.
- No UI surfacing of usage data — a future concern, not this foundation.
- No live integration test against the real OpenRouter API in CI — verification covers the request-building logic as a pure function; a real end-to-end call is a manual verification step.
- No response parsing/validation into task-specific shapes (e.g., structured canvas JSON) — each consuming slice owns parsing its own response shape; this foundation returns the raw assistant text.

## Implementation Approach

Mirror the existing Supabase integration pattern end-to-end: a schema-declared secret, a factory/call function in `src/lib/`, and the same CI secret-injection path. Keep the public contract intentionally narrow (`complete()` takes a task kind + chat messages + the caller's Supabase client, returns a typed result with raw text + usage) so the four future consumers — which have genuinely different shapes (generation, suggestion, multi-turn chat, classification) — aren't forced into a premature shared interface beyond model/timeout/retry/privacy/usage-recording, which is what's actually common to all of them.

## Critical Implementation Details

**Migration directory timing.** `supabase/migrations/` does not exist yet. If this change is implemented before `F-01` (data-workspace-scaffold), Phase 2 here creates the directory and establishes the migration-file naming convention (`supabase migration new <name>`, timestamp-prefixed). If `F-01` lands first, Phase 2 simply adds its migration file into the already-existing directory following that same convention. Either order works; just don't assume the directory exists or doesn't.

**Privacy enforcement is a request-body field, not a dashboard setting.** The NFR ("founder content never used for training or retained") is satisfied by setting `provider: { data_collection: "deny" }` on every outgoing request — not by an account-level OpenRouter dashboard toggle. This must be set inside the pure request-builder function (not sprinkled at call sites) so Phase 4's test can assert it's always present.

## Phase 1: Secrets & environment plumbing

### Overview

Wire `OPENROUTER_API_KEY` through the same path `SUPABASE_URL`/`SUPABASE_KEY` already use, so local dev, CI, and (per the user's manual deployment step) Cloudflare Pages all have the secret available by the time Phase 3's client code runs.

### Changes Required:

#### 1. Astro env schema

**File**: `astro.config.mjs`

**Intent**: Declare `OPENROUTER_API_KEY` as a server-only secret, consistent with the two existing entries.

**Contract**: Add `OPENROUTER_API_KEY: envField.string({ context: "server", access: "secret", optional: true })` to the `env.schema` object (same shape as `SUPABASE_URL`/`SUPABASE_KEY`).

#### 2. Local env template

**File**: `.env.example`

**Intent**: Document the new required variable for local development.

**Contract**: Append `OPENROUTER_API_KEY=###` as a third line, matching the existing two-line format.

#### 3. CI build env

**File**: `.github/workflows/ci.yml`

**Intent**: Make the secret available to the `ci` job's build step, matching the existing Supabase secrets.

**Contract**: Add `OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}` alongside `SUPABASE_URL`/`SUPABASE_KEY` under the `npm run build` step's `env:` block in the `ci` job. The `smoke` job is unaffected — it doesn't exercise any AI call path.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Build succeeds locally with `OPENROUTER_API_KEY` unset (env field is `optional: true`, matching existing behavior for the Supabase vars): `npm run build`

#### Manual Verification:

- A `OPENROUTER_API_KEY` repository secret is added in GitHub (mirrors how `SUPABASE_URL`/`SUPABASE_KEY` secrets were added) so CI's `ci` job has it available.
- A Cloudflare Pages/Workers secret binding for `OPENROUTER_API_KEY` is added in the Cloudflare dashboard for the deployed environment (this is an operational step outside the repo, parallel to however the Supabase secrets are bound there today).

---

## Phase 2: Usage ledger migration

### Overview

Create the table every successful AI call will write one row into, keyed on the founder's `auth.users.id` so it has no dependency on any other foundation's schema.

### Changes Required:

#### 1. Migration file

**File**: `supabase/migrations/<timestamp>_ai_usage_events.sql` (timestamp generated via `supabase migration new ai_usage_events`)

**Intent**: Store one row per successful AI call for the usage-tracking requirement the PRD's Non-Goals section carries forward ("still recorded through the same usage-tracking system so accounting stays consistent once billing is added later").

**Contract**: Table `ai_usage_events` with columns: `id uuid primary key default gen_random_uuid()`, `founder_id uuid not null references auth.users(id)`, `task_kind text not null check (task_kind in ('draft', 'suggest', 'converse', 'score'))`, `model text not null`, `prompt_tokens integer not null`, `completion_tokens integer not null`, `total_tokens integer not null`, `created_at timestamptz not null default now()`. RLS enabled with two policies: `select` where `founder_id = auth.uid()`, and `insert` with check `founder_id = auth.uid()` (no `update`/`delete` policies — the ledger is append-only).

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly against local Supabase: `supabase db reset` (or `supabase migration up` in the existing local stack)
- Lint passes on the migration file per repo convention (if `supabase db lint` or equivalent is configured; otherwise skip): N/A if no SQL linter is configured

#### Manual Verification:

- Inspecting the local Supabase Studio (or `supabase db diff`) confirms the table and both RLS policies exist exactly as specified.
- A row inserted via the authenticated founder's own session succeeds; a row insert attempted for a different `founder_id` is rejected by RLS.

---

## Phase 3: AI client module

### Overview

The core of this foundation: a `complete()` function that any server-side route can call, with the per-task config, privacy enforcement, retry/timeout handling, and automatic usage recording all in one place.

### Changes Required:

#### 1. AI provider dependency

**File**: `package.json`

**Intent**: No new dependency is required — OpenRouter's chat-completions endpoint is a plain HTTPS POST and this plan uses the platform `fetch` already available in the Cloudflare Workers runtime, consistent with the codebase's existing preference for minimal dependencies.

**Contract**: No changes to `dependencies`.

#### 2. Per-task configuration

**File**: `src/lib/ai.ts` (new)

**Intent**: Define the four task kinds and their default model/timeout, so future slices select a kind rather than hardcoding a model or timeout at their own call site.

**Contract**:

```ts
export type AITaskKind = "draft" | "suggest" | "converse" | "score";

const TASK_CONFIG: Record<AITaskKind, { model: string; timeoutMs: number }> = {
  draft: { model: "openai/gpt-4o-mini", timeoutMs: 15_000 },
  suggest: { model: "openai/gpt-4o-mini", timeoutMs: 15_000 },
  converse: { model: "openai/gpt-4o-mini", timeoutMs: 10_000 },
  score: { model: "openai/gpt-4o-mini", timeoutMs: 25_000 },
};
```

All four kinds share one default model today per this plan's scoping decision; each entry is independently swappable later without touching any call site. The model string is a plain OpenRouter model slug — the implementer should confirm current pricing/availability for `openai/gpt-4o-mini` (or substitute an equivalent cost-effective general-purpose model) at implementation time, since model availability on OpenRouter can change.

#### 3. Request builder (pure function)

**File**: `src/lib/ai.ts`

**Intent**: Isolate request-body construction as a pure function so Phase 4 can test the privacy flag and model resolution without mocking `fetch` or making a network call.

**Contract**: `buildOpenRouterRequest(taskKind: AITaskKind, messages: { role: "system" | "user" | "assistant"; content: string }[], overrideModel?: string)` returns the JSON-serializable request body: `{ model, messages, provider: { data_collection: "deny" } }`, where `model` resolves from `overrideModel` if given, else `TASK_CONFIG[taskKind].model`.

#### 4. Typed result and the `complete` function

**File**: `src/lib/ai.ts`

**Intent**: Give every future call site one consistent shape for success and failure, with retry handled once in this single place rather than four times downstream.

**Contract**:

```ts
export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type AIResult =
  | { ok: true; text: string; usage: AIUsage; model: string }
  | { ok: false; error: { kind: "timeout" | "rate_limited" | "provider_error" | "invalid_response"; message: string } };

export async function complete(params: {
  taskKind: AITaskKind;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  supabase: SupabaseClient;
  founderId: string;
  overrideModel?: string;
}): Promise<AIResult>;
```

`complete()`: reads `OPENROUTER_API_KEY` from `astro:env/server` (returns `{ ok: false, error: { kind: "provider_error", message: "OpenRouter is not configured" } }` if missing, matching `createClient`'s null-guard convention in spirit); builds the request via `buildOpenRouterRequest`; POSTs to `https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer <key>` and the resolved timeout via `AbortSignal.timeout(...)`; on timeout, 429, or 5xx, waits ~500ms and retries once with the same timeout; on a second failure, returns the corresponding typed error; on success, parses the OpenAI-compatible response shape (`choices[0].message.content`, `usage.{prompt,completion,total}_tokens`), inserts one row into `ai_usage_events` via the passed-in `supabase` client (using `founderId`), and returns `{ ok: true, text, usage, model }`. A failure to insert the usage row does not fail the overall call — the AI response is still returned to the caller, with the insert error logged via `console.error` (no retry on the usage-insert itself; it's non-critical telemetry, not the value delivered to the founder).

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- A one-off manual call to `complete()` from a scratch script or temporary route, with a real `OPENROUTER_API_KEY` in `.env`, returns `{ ok: true, ... }` for a simple prompt.
- The same manual call produces exactly one new row in `ai_usage_events` for the calling founder.
- Temporarily setting an invalid `OPENROUTER_API_KEY` and re-running confirms a typed `{ ok: false, error: { kind: "provider_error" } }` result rather than an unhandled exception.

---

## Phase 4: Automated verification

### Overview

Prove the two invariants that matter most — the privacy opt-out is always present, and each task kind resolves to its configured model — the same way `scripts/smoke.mjs` already proves the auth flow: a plain Node script, no new dependency, wired into CI.

### Changes Required:

#### 1. Verification script

**File**: `scripts/test-ai-client.mjs` (new)

**Intent**: Import `buildOpenRouterRequest` directly and assert its output shape for all four task kinds — no network call, no mocking needed, since the function under test is pure.

**Contract**: For each of `"draft" | "suggest" | "converse" | "score"`, assert the built request has `provider.data_collection === "deny"` and `model === TASK_CONFIG[taskKind].model` (exported alongside `buildOpenRouterRequest` for the test to reference); also assert an `overrideModel` argument wins over the default. Follows `scripts/smoke.mjs`'s existing pattern: a `steps` list of `[name, assertionFn]`, a pass/fail counter, `process.exit(failed ? 1 : 0)`.

#### 2. npm script

**File**: `package.json`

**Intent**: Give the new script a conventional entry point alongside `smoke`.

**Contract**: Add `"test:ai": "node scripts/test-ai-client.mjs"` to `scripts`.

#### 3. CI wiring

**File**: `.github/workflows/ci.yml`

**Intent**: Run the new check on every push/PR, same as lint/build.

**Contract**: Add a `- run: npm run test:ai` step to the `ci` job, after `npm run build` (the script imports from `src/lib/ai.ts` directly via Node's TypeScript-less ESM — if this requires a build/transpile step to resolve, place the step after `npm run build` and import from the built output instead; confirm which at implementation time based on whether `src/lib/ai.ts` can be imported directly by plain Node in this project's current `type: "module"` + TypeScript setup).

### Success Criteria:

#### Automated Verification:

- New script passes locally: `npm run test:ai`
- CI's `ci` job passes end-to-end with the new step included

#### Manual Verification:

- Deliberately removing `provider: { data_collection: "deny" }` from `buildOpenRouterRequest` locally and re-running `npm run test:ai` confirms the script fails (proves the test actually catches a regression, not just that it passes today).

---

## Testing Strategy

### Unit Tests:

- `buildOpenRouterRequest` always includes the privacy opt-out, regardless of task kind.
- `buildOpenRouterRequest` resolves the correct default model per task kind, and an explicit `overrideModel` takes precedence.

### Integration Tests:

- None added in CI (no live OpenRouter calls in automated CI, per the capacity/cost tradeoff this plan makes explicit in "What We're NOT Doing").

### Manual Testing Steps:

1. Set a real `OPENROUTER_API_KEY` in `.env`, call `complete()` with a trivial prompt for each of the four task kinds, confirm `{ ok: true }` and a plausible response for each.
2. Confirm one `ai_usage_events` row per successful call, correctly attributed to the calling founder, with non-zero token counts.
3. Confirm a RLS violation (attempting to read another founder's usage rows) is rejected.
4. Temporarily break the API key, confirm a typed failure result surfaces rather than an unhandled exception or hang.

## Performance Considerations

Per-task timeouts (15s draft/suggest, 10s converse, 25s score) are starting defaults sized against the PRD's stated NFRs (persona reply p95 < 8s, scorecard within 30s) with headroom for the one retry; actually hitting those NFRs in production depends on the specific model chosen per task and live network conditions, which is something each consuming slice's own plan (`S-02`, `S-04`, `S-05`, `S-06`) should verify once real prompts exist — this foundation only guarantees the timeout is enforced and configurable, not that the chosen model is fast enough.

## Migration Notes

No existing data to migrate — this is a new table in a pre-launch project.

## References

- Roadmap: `context/foundation/roadmap.md` (`F-02: AI provider integration`)
- Change brief: `context/changes/ai-provider-integration/change.md`
- Pattern mirrored: `src/lib/supabase.ts:1-21`, `astro.config.mjs:17-22`
- Testing convention followed: `scripts/smoke.mjs`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Secrets & environment plumbing

#### Automated

- [ ] 1.1 Type checking passes: `npx astro check`
- [ ] 1.2 Linting passes: `npm run lint`
- [ ] 1.3 Build succeeds locally with `OPENROUTER_API_KEY` unset: `npm run build`

#### Manual

- [ ] 1.4 `OPENROUTER_API_KEY` GitHub Actions repository secret added
- [ ] 1.5 Cloudflare Pages/Workers secret binding for `OPENROUTER_API_KEY` added

### Phase 2: Usage ledger migration

#### Automated

- [ ] 2.1 Migration applies cleanly against local Supabase: `supabase db reset`

#### Manual

- [ ] 2.2 Table and both RLS policies confirmed via Supabase Studio / `supabase db diff`
- [ ] 2.3 RLS confirmed: own-row insert succeeds, other-founder insert rejected

### Phase 3: AI client module

#### Automated

- [ ] 3.1 Type checking passes: `npx astro check`
- [ ] 3.2 Linting passes: `npm run lint`
- [ ] 3.3 Build succeeds: `npm run build`

#### Manual

- [ ] 3.4 Manual `complete()` call with real API key returns `{ ok: true, ... }`
- [ ] 3.5 One new `ai_usage_events` row confirmed per successful call
- [ ] 3.6 Invalid API key produces typed `{ ok: false }` result, not an unhandled exception

### Phase 4: Automated verification

#### Automated

- [ ] 4.1 New script passes locally: `npm run test:ai`
- [ ] 4.2 CI `ci` job passes end-to-end with the new step included

#### Manual

- [ ] 4.3 Deliberately breaking the privacy flag locally confirms `npm run test:ai` fails
