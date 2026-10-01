# Rehearsal Session Turn Exchange — Plan Brief

> Full plan: `context/changes/rehearsal-session-turn-exchange/plan.md`

## What & Why

A founder starts a rehearsal on one of their active assumptions and exchanges up to 8 interview questions with a hidden AI persona, ending early or at the cap. This is roadmap slice S-05 (FR-012 to FR-014): the practice half of the north star. The persona must never leak, and never says the idea is "validated".

## Starting Point

No domain schema or code exists yet. F-01 (workspaces), F-02 (`complete()`) and S-02 (projects/canvas) are planned but unbuilt. **S-04 (assumptions) has no plan**, so this plan assumes a minimal `assumptions(id, project_id, text, status)` contract.

## Desired End State

A signed-in founder opens `/rehearsal`, starts a session on an active assumption, chats with the persona (pending state, per-turn Retry), and ends it early or at turn 8. An ended session shows a read-only transcript and a scorecard placeholder. The scenario is unreachable from any client path.

## Key Decisions Made

| Decision            | Choice                                                                    | Why                                                     |
| ------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| S-04 gap            | Plan against a stated minimal assumptions contract                        | Unblocks planning; adjust later if S-04 differs         |
| Scenario hiding     | Separate table, RLS on, no client policies; service-role reads            | A route bug cannot leak it via the founder's own client |
| Scenario generation | One AI call at session start                                              | Real hidden persona, consistent across turns            |
| Turn cap            | 8, constant in code and DB check                                          | Lowest PRD value; bounds AI cost                        |
| Turn persistence    | Question saved first, reply attached after; `unique (session, seq)`       | A failed AI call never loses the question               |
| AI failure          | Per-turn Retry, cap not consumed twice                                    | Founders get few sessions a month                       |
| Lifecycle           | `status` + `ended_reason`; one active session per project (partial index) | Race-proof; clean ended signal for S-06                 |
| Persona honesty     | Prompt rules plus server-side reply guard                                 | Hard PRD guardrail enforced in code                     |
| UI                  | React chat island over JSON routes                                        | Chat feel and pending states without streaming          |
| Testing             | SQL assertion script + Node fixture script                                | Repo conventions, no new dependency                     |

## Scope

**In scope:** schema + RLS, persona module, service-role client, orchestration, four JSON routes, start page, chat island, dashboard link, tests.

**Out of scope:** scoring and scorecard (S-06), resume/idempotency keys (S-07), streaming, assumption management (S-04), curated templates, rate limiting.

## Architecture / Approach

Founders get SELECT only; every write goes through server routes using a service-role client after an RLS-scoped ownership check. `complete()` always gets the founder's client so the usage ledger stays attributed. Pure persona logic (prompts, parser, reply guard) is Node-testable; a thin orchestration service handles start, turn, retry and end.

## Phases at a Glance

| Phase               | What it delivers                                     | Key risk                                        |
| ------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| 1. Schema and types | Three tables, RLS, SQL test, types                   | Privacy/RLS correctness; S-04 contract mismatch |
| 2. Persona module   | Prompts, scenario parser, reply guard, fixture tests | Persona quality needs real-model tuning         |
| 3. Server plumbing  | Service-role secret and client, orchestration        | Mixing the two clients; new secret to provision |
| 4. API routes       | Start, turn, retry, end routes; middleware           | Race handling and no-leak responses             |
| 5. UI               | Start page, chat island, ended transcript, dashboard | Latency of scenario start and replies           |

**Prerequisites:** F-01, F-02, S-02 implemented; S-04 assumptions table available (or the stated contract created).
**Estimated effort:** ~4-5 sessions across 5 phases.

## Open Risks & Assumptions

- S-04's assumptions schema is assumed; a mismatch needs small Phase 1/5 edits.
- F-02's `converse` timeout (10s plus one retry) is looser than the p95 < 8s NFR; verify with the real model.
- A new secret (`SUPABASE_SERVICE_ROLE_KEY`) must be provisioned in GitHub and Cloudflare.
- Persona quality (realistic yet useful) is the product's riskiest piece; the PRD's curated-template fallback remains available if it misses.

## Success Criteria (Summary)

- A founder completes a full 8-turn rehearsal, or ends early, without losing a turn.
- The persona scenario is never visible to a client, in data, responses, or logs.
- No persona reply ever claims the idea is validated.
