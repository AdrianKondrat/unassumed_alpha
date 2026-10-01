# Resumable Rehearsal Sessions — Plan Brief

> Full plan: `context/changes/resumable-rehearsal-sessions/plan.md`

## What & Why

A disrupted rehearsal session (refresh, tab close, brief disconnect) must resume without duplicating or losing any turn, up to session expiry (PRD FR-017). Founders get only a handful of rehearsals per month, so losing one to a glitch directly costs them value and trust.

## Starting Point

S-05's plan (not yet built) already saves each question before the AI call, bounds `seq` with a unique key, and lets Retry re-request a reply without adding a turn. It leaves three gaps for this slice: a re-sent question after a lost response becomes a duplicate turn, an unanswered turn only has a manual Retry (and can race a still-running request), and there is no session-expiry policy.

## Desired End State

A founder can refresh, close the tab, or lose connectivity mid-session and come back to every saved question exactly once, with any in-flight reply arriving or resuming automatically. After 24h of inactivity the session becomes a read-only, still-scorable transcript and no longer blocks a new session.

## Key Decisions Made

| Decision                  | Choice                                                 | Why (1 sentence)                                                               | Source |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ | ------ |
| Duplicate-send protection | Client-generated UUID per question, unique per session | Exact dedupe that stays correct if the founder genuinely repeats a question.   | Plan   |
| Pending-reply recovery    | Auto-resume under a 30s reply lease                    | Founder sees the reply without clicking, and two requests can't both generate. | Plan   |
| Replayed key response     | Return current turn state (answered or pending)        | One rule keeps the client simple.                                              | Plan   |
| Session expiry            | 24h idle, applied lazily on read/start                 | Frees the one-active slot with no cron, and matches a working sitting.         | Plan   |
| Expired data              | Kept read-only, scorable via S-06                      | The PRD's trust argument: never lose practice already done.                    | Plan   |
| Reconnect                 | Refetch on focus/online, poll only while pending       | Handles sleeping laptops and background tabs with no new infrastructure.       | Plan   |
| Testing                   | SQL assertions + pure-module fixture script            | Matches the repo's zero-dependency convention.                                 | Plan   |

## Scope

**In scope:** idempotency key, reply lease, lazy idle expiry, state route, resilient chat hook and expired view, tests.

**Out of scope:** Realtime/websockets, streaming, cron expiry, offline queueing, scoring changes, HTTP-level CI tests, configurable expiry.

## Architecture / Approach

One pure module (`rehearsal-resume.ts`) owns lease, expiry and replay decisions. S-05's service and routes call it: send looks up the key first, claims the turn with a conditional update before generating, and applies expiry on every load. The chat hook treats the server as truth, generating one key per question, refetching on focus/online, polling while pending, and auto-retrying a stale pending turn once.

## Phases at a Glance

| Phase                    | What it delivers                                            | Key risk                                      |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------- |
| 1. Schema and pure rules | Additive migration, resume module, fixtures, SQL assertions | S-05's tables may change shape before landing |
| 2. Service and routes    | Idempotent send, lease claim, lazy expiry, GET state route  | Claim race correctness                        |
| 3. Chat UI               | Key generation, resync, polling, auto-resume, expired view  | Polling or resync clobbering typed input      |
| 4. End-to-end check      | Full disruption run, roadmap and S-06 hand-off notes        | Real-model timing vs the lease                |

**Prerequisites:** S-05 implemented (or its migration not yet applied, so columns can be folded in).
**Estimated effort:** ~3-4 sessions across 4 phases.

## Open Risks & Assumptions

- S-05, S-04 and F-02 are unbuilt; this plan assumes S-05's planned schema and service names.
- The 30s lease assumes S-05's `converse` worst case stays under ~21s.
- Lazy expiry means an idle session stays `active` in the DB until someone reads it; acceptable because nothing else depends on it.

## Success Criteria (Summary)

- A full 8-turn session with a refresh, tab close and offline send ends with exactly 8 turns, none duplicated or lost.
- Double-clicking Send produces one turn; an aborted reply resumes without a second generation.
- A 24h-idle session shows as an expired read-only transcript and no longer blocks a new session.
