# Resumable Rehearsal Sessions Implementation Plan

## Overview

Make an in-progress rehearsal session survive a refresh, tab close or brief disconnect without losing or duplicating any turn, up to session expiry. A re-sent question is deduplicated by a client-generated key, an unanswered turn is resumed under a short lease, and an active session that sits idle for 24h expires into a read-only, still-scorable transcript. This is slice S-07 in `context/foundation/roadmap.md` (PRD FR-017), parallel with S-06.

## Current State Analysis

- No domain code exists yet. S-07 builds on the **planned, unimplemented** S-05 plan (`context/changes/rehearsal-session-turn-exchange/plan.md`); it assumes S-05's tables and service as written there and ships as an additive migration plus edits to S-05's files. If S-05 changes shape before it lands, reconcile names in Phases 1-3 only.
- S-05 already provides the foundation: question saved before the AI call, `unique (session_id, seq)` with `seq` 1..8, Retry that never inserts a turn, one active session per project (partial unique index), writes through a service-role client after an RLS-scoped ownership check.
- Gaps S-05 explicitly leaves for S-07 (its "What We're NOT Doing"):
  - A re-sent POST after a lost response creates a **new** turn once the first reply has landed (duplicate question, cap burned).
  - A page that loads onto a reply-less turn offers only manual Retry, and a refresh during a slow request can run two reply generations at once.
  - The chat island trusts its local state after a disconnect or a backgrounded tab.
  - FR-017 says "up to session expiry" but no expiry policy exists, and an abandoned active session blocks starting a new one on that project.
- S-06 (`rehearsal-scorecard`) triggers scoring from S-05's end handler and requires an `ended` session with founder turns. Expired sessions become `ended`, so S-06's own POST route can score them; only S-06's "at least one replied turn" rule applies.
- Conventions to follow: pure modules in `src/lib/services/*.ts` with relative imports, tested by zero-dependency Node scripts; SQL assertion scripts run with `psql`; zod validation on routes; React hooks in `src/components/hooks/`.

## Desired End State

A founder in the middle of a session can close the tab, lose connectivity or refresh at any moment and, on return (within 24h of their last activity):

1. Sees every saved question exactly once, in order, with no duplicate.
2. If a reply was in flight or abandoned, sees it either arrive (still generating) or resume automatically (abandoned), without clicking Retry and without a second generation racing the first.
3. Can re-send a question after a lost response and gets the existing turn back instead of a new one; the turn cap is consumed once.
4. Gets back in sync after the network returns or the tab is foregrounded, without a manual refresh.
5. After 24h idle sees a read-only transcript marked expired, is free to start a new session on that project, and can still get the expired session scored if it has at least one replied turn.

Verification: the extended SQL assertion script and a new `npm run test:rehearsal-resume` fixture script pass; `npm run lint`, `npx astro check`, `npm run build` and `npm run smoke` stay green; the manual disruption scenarios in Phase 4 pass against local Supabase with a real OpenRouter key.

### Key Discoveries:

- Dedupe needs a **client-generated key**, not content matching: only a key stays correct when the founder deliberately asks the same text twice (decision: Plan).
- A lease on the reply (`reply_started_at`, stale after ~30s) is the same idempotency pattern already planned for S-02 (`draft_started_at`) and S-06 (`scoring_started_at`); reuse its constant and shape rather than inventing another.
- S-05's `converse` timeout is 10s with one retry (~21s worst case), so a 30s lease cannot expire under a healthy live request.
- Expiry can be lazy (evaluated on read and on start), so no cron or scheduled worker is required on Cloudflare Workers.
- The PRD's persona-privacy rule still applies: the new state route returns only session id, status, and turns (`seq`, `question`, `reply`); never the scenario.

## What We're NOT Doing

- No Supabase Realtime or websockets; recovery is refetch plus polling.
- No streaming replies and no cross-device live sync beyond what refetch gives.
- No scheduled job to flip expired sessions; expiry is applied lazily.
- No change to the turn cap, scoring logic, or persona prompts.
- No session deletion, session history list, or configurable expiry.
- No HTTP-level route tests or AI stub in CI (the repo has no runner or AI stub); route wiring is verified manually.
- No offline queueing of questions typed while disconnected; the send simply fails and can be re-sent with the same key.

## Implementation Approach

Keep S-05's rule "persist first, reply second" and add three small server-side primitives: an idempotency key on the question, a lease on the reply, and lazy idle expiry. All decision logic (is a lease stale, is a session expired, what does a replayed key return) lives in one pure module so it is testable without a network. The service and routes become thin callers of that module. The chat hook then treats the server as the source of truth: it generates one key per question, refetches state on focus/online, polls while a turn is pending, and auto-resumes a stale pending turn.

## Critical Implementation Details

- **Replay returns current state.** A send whose `(session_id, client_key)` already exists returns that turn as 200: with its reply if stored, otherwise as pending so the client polls. It never inserts a second turn and never errors for "reply_pending" on the same key. A _different_ key while the latest turn is reply-less still returns 409 `reply_pending`, as in S-05.
- **Claim before generating.** Generating a reply first claims the turn by setting `reply_started_at = now()` with a conditional update (only where `reply IS NULL` and the lease is null or stale) and checking that one row changed. The request that loses the claim returns the pending state and does not call the AI. The lease is cleared when the reply is stored; on AI or guard failure it is cleared so Retry works immediately.
- **Expiry is lazy and atomic.** Any read or write that loads a session first applies expiry: an `active` session whose `last_activity_at` is older than 24h is updated to `status = 'ended'`, `ended_reason = 'expired'`, `ended_at = now()` with a conditional update, so concurrent callers converge. Starting a session on a project runs expiry on that project's active session first, so a stale session never blocks a new one. `last_activity_at` is bumped when a question is accepted and when a reply is stored (not on reads or polls, or polling would keep a session alive forever).
- **Zero-turn expiry.** An expired session with no replied turn is simply ended; it stays viewable and S-06's existing "not enough transcript" rule applies.

## Phase 1: Schema and pure resume rules

### Overview

Add the columns and constraints that make resume correct in the database, and put the lease and expiry decisions in a tested pure module.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/<timestamp>_rehearsal_resume.sql` (generate with `npx supabase migration new rehearsal_resume`; must sort after S-05's migration)

**Intent**: Extend S-05's tables additively with the idempotency key, reply lease and idle-activity tracking, and allow the `expired` end reason.

**Contract**:

- `rehearsal_turns`: add `client_key uuid not null` and a unique index on `(session_id, client_key)`; add `reply_started_at timestamptz` (null when no reply is being generated).
- `rehearsal_sessions`: add `last_activity_at timestamptz not null default now()`; replace the `ended_reason` check with `in ('user','cap','expired')`, keeping the existing status/ended consistency check intact.
- No new policies: founders keep SELECT only; all writes stay service-role. The new columns hold no scenario data. Note in a SQL comment that the 24h idle window mirrors the code constant.
- If S-05 has not yet been applied anywhere, this may be folded into S-05's migration at implementation time; keep it a separate file if S-05 has landed.

#### 2. Pure resume module

**File**: `src/lib/services/rehearsal-resume.ts` (new; relative imports only, nothing from `astro:*` or `@/`)

**Intent**: Own every time-based and replay-based decision so it can be tested deterministically.

**Contract**: Exports `REPLY_LEASE_MS = 30_000` (reuse S-02/S-06's lease constant by relative import if it exists), `SESSION_IDLE_EXPIRY_MS = 24 * 60 * 60 * 1000`; `isLeaseStale({ replyStartedAt, now })`; `isSessionExpired({ status, lastActivityAt, now })` (never true for an already-ended session); `classifyTurn({ reply, replyStartedAt, now })` returning `"answered" | "in_flight" | "needs_reply"` (in flight = lease set and fresh); and `resolveReplay({ existingTurn, now })` returning what a repeated key should return (`{ kind: "answered", turn } | { kind: "pending", turn }`). Time is always passed in, never read inside.

#### 3. Fixture tests and SQL assertions

**Files**: `scripts/test-rehearsal-resume.mjs` (new), `supabase/tests/rehearsal_resume.sql` (new), `package.json`

**Intent**: Prove the rules without a network, in the style of `scripts/smoke.mjs`, and prove the DB invariants.

**Contract**: Script `"test:rehearsal-resume": "node --experimental-strip-types scripts/test-rehearsal-resume.mjs"`. Fixtures cover lease fresh/stale at the boundary, expiry at and just under 24h, ended sessions never expiring, and replay resolution for answered, pending and in-flight turns. SQL (single transaction, rolled back, `ON_ERROR_STOP`): a duplicate `(session_id, client_key)` is rejected while the same key in another session is allowed; `ended_reason = 'expired'` is accepted with `status = 'ended'` and rejected with `status = 'active'`; a missing `client_key` is rejected; authenticated users still cannot write the new columns.

### Success Criteria:

#### Automated Verification:

- Migration applies on a fresh DB: `npx supabase db reset`
- No migration lint errors: `npx supabase db lint`
- SQL assertions pass: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rehearsal_resume.sql`
- Fixture tests pass: `npm run test:rehearsal-resume`
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`

#### Manual Verification:

- Reading the fixtures confirms the boundary cases (exactly 30s, exactly 24h) match the intended behavior.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding to the next phase.

---

## Phase 2: Idempotent service and routes

### Overview

Make `sendTurn`, `retryReply` and session loading resume-safe, and add a read route the client can poll.

### Changes Required:

#### 1. Service changes

**File**: `src/lib/services/rehearsal-service.ts` (S-05; edit)

**Intent**: Apply the replay, claim and expiry rules from Critical Implementation Details to the existing lifecycle functions.

**Contract**:

- `sendTurn({ sessionId, question, clientKey })`: apply expiry; look up `(session_id, client_key)` first and return `resolveReplay` output for a hit; otherwise insert the turn with the key (`seq` as in S-05), bump `last_activity_at`, then claim and generate the reply. A unique violation on the key (concurrent duplicate) is treated as a replay hit. Outcomes add `{ ok: true, turn, pending: true }` for a replay of an in-flight turn; the failure codes from S-05 are unchanged and `not_active` now also covers `expired`.
- `retryReply({ sessionId })`: uses the same conditional claim; if the claim is lost, returns the pending state instead of generating.
- `getSessionState({ sessionId })` (new): RLS-scoped ownership read, expiry applied, returns `{ session: { id, status, endedReason }, turns }` with each turn classified via `classifyTurn`. Never reads the scenario.
- `startSession`: apply expiry to the project's active session before checking for an existing one, so a stale session is ended and a new one can start.
- `endSession` stays idempotent; ending an already-expired session returns ok.

#### 2. Routes

**Files**: `src/pages/api/rehearsal/sessions/[id]/turns.ts` (edit), `src/pages/api/rehearsal/sessions/[id]/retry.ts` (edit), `src/pages/api/rehearsal/sessions/[id]/index.ts` (new, `GET`)

**Intent**: Carry the client key through send, map the pending outcome, and expose resume state for polling.

**Contract**: `turns` body adds `clientKey` (zod `uuid`, required). A replayed key returns 200 with the turn; `pending: true` when no reply is stored yet. `retry` returns 200 with pending when the claim is lost. `GET /api/rehearsal/sessions/[id]` returns `{ status, endedReason, turns: [{ seq, question, reply, state }] }`, 401/404 as S-05; `prerender = false`. Bodies still contain no scenario, prompts or model details, and no `console.*` output includes scenario text.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Build passes: `npm run build`
- Fixture tests still pass: `npm run test:rehearsal-resume`

#### Manual Verification:

- With curl and a signed-in cookie: posting the same `clientKey` twice yields one turn and the same reply; a different key while the latest turn has no reply returns 409.
- Killing a request mid-AI-call (curl max-time) leaves a reply-less turn; `GET` shows `in_flight` for ~30s, then `needs_reply`; a retry then produces a reply without adding a turn.
- A session whose `last_activity_at` is backdated by 25h returns `expired` on `GET` and no longer blocks `startSession` for that project.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding to the next phase.

---

## Phase 3: Resilient chat UI

### Overview

Teach the chat hook to treat the server as the source of truth and resume without manual steps.

### Changes Required:

#### 1. Resume-aware hook

**File**: `src/components/hooks/useRehearsalSession.ts` (S-05; edit)

**Intent**: Generate a key per question, resync after disruptions, and auto-resume a stale pending turn.

**Contract**: Generate `crypto.randomUUID()` when the founder submits and hold it until that question is answered, so double-clicks, a failed fetch and a Retry all re-send the same key. On mount, on `visibilitychange` to visible and on the window `online` event, fetch the state route and replace local turns with the server's. While the latest turn is `in_flight`, poll every ~2s (stop on answered, ended, or unmount); when it is `needs_reply`, automatically call retry once, then fall back to the visible Retry button if that fails. Polling and refetch never reset the input text the founder is typing.

#### 2. Chat and page updates

**Files**: `src/components/rehearsal/RehearsalChat.tsx`, `src/pages/rehearsal/[id].astro`, `src/pages/rehearsal/index.astro` (S-05; edit)

**Intent**: Show recovery states plainly and handle expiry.

**Contract**: The pending indicator reads "Waiting for the reply" and stays `aria-live` polite; a brief "Reconnected, your conversation is up to date" note appears after a resync that changed state. An expired session renders the read-only transcript with "This session expired after 24 hours of inactivity" and no input; the list page shows it as ended, not as Continue. The server-rendered initial props use the same state function as the route, so first paint already reflects expiry and pending classification.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Build passes: `npm run build`
- Smoke test still passes: `npm run smoke`

#### Manual Verification:

- Refresh while a reply is generating: the reply appears without clicking and there is exactly one turn.
- Close the tab right after sending, reopen the session: the question is present once and the reply arrives or is resumed automatically.
- Toggle the browser offline, send, go online: the same question is re-sent with its key and shows once.
- Background the tab for more than 30s mid-reply and return: state is current without a manual refresh.
- Typed-but-unsent text survives a resync.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding to the next phase.

---

## Phase 4: End-to-end disruption check and hand-offs

### Overview

Prove the full FR-017 acceptance against local Supabase and a real model, and close the loose ends with neighboring slices.

### Changes Required:

#### 1. Roadmap and hand-off notes

**Files**: `context/foundation/roadmap.md`, `context/changes/resumable-rehearsal-sessions/change.md`

**Intent**: Record status and the S-06 hand-off.

**Contract**: Set S-07 status to reflect progress per roadmap convention; add a note in the change's Notes that expired sessions are `ended` with `ended_reason = 'expired'` and are scored only via S-06's POST route (no automatic scoring on lazy expiry), and that S-06's scoring gate must treat `expired` like `user`/`cap`.

### Success Criteria:

#### Automated Verification:

- All checks green together: `npm run lint && npx astro check && npm run build && npm run smoke && npm run test:rehearsal-resume`

#### Manual Verification:

- Full 8-turn session with a refresh, a tab close and an offline send in the middle ends with exactly 8 turns, none duplicated, none lost.
- Double-clicking Send produces one turn.
- A session backdated 25h shows as expired and read-only, a new session can start, and S-06 scoring (if landed) works on the expired transcript.
- No scenario text appears in page source, the Network tab, the state route, or server logs.

---

## Testing Strategy

### Unit Tests:

- `scripts/test-rehearsal-resume.mjs`: lease staleness boundary, expiry boundary, ended sessions never expiring, turn classification, replay resolution.

### Integration Tests:

- `supabase/tests/rehearsal_resume.sql`: key uniqueness per session, `expired` end reason consistency, required key, client write rejection on the new columns.

### Manual Testing Steps:

1. Send the same `clientKey` twice with curl; confirm one turn.
2. Abort a request mid-reply; confirm `in_flight` then `needs_reply` and a clean resume.
3. Refresh, close the tab and go offline mid-session in the browser; confirm no duplicate or lost turns.
4. Backdate `last_activity_at` by 25h; confirm expiry, read-only view, and that a new session starts.

## Performance Considerations

Polling runs only while a turn is pending, every ~2s, one small RLS-scoped read per tick; reads and polls do not bump `last_activity_at`. The lease (30s) exceeds S-05's worst-case `converse` duration (~21s), so a healthy in-flight request is never mistaken for abandoned.

## Migration Notes

No existing data; new columns on tables from a pre-launch slice. `client_key` is `not null`, so it must land with S-05's tables or before any rows exist; fold into S-05's migration if S-05 has not been applied.

## References

- Roadmap: `context/foundation/roadmap.md` (S-07)
- PRD: `context/foundation/prd.md` (FR-017, and the session-expiry counter-argument near line 81)
- Builds on: `context/changes/rehearsal-session-turn-exchange/plan.md`
- Neighbor: `context/changes/rehearsal-scorecard/plan.md` (lease pattern, scoring trigger)
- Patterns mirrored: `scripts/smoke.mjs`, S-02/S-06 lease columns

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema and pure resume rules

#### Automated

- [ ] 1.1 Migration applies on a fresh DB: `npx supabase db reset`
- [ ] 1.2 No migration lint errors: `npx supabase db lint`
- [ ] 1.3 SQL assertions pass: `psql ... -f supabase/tests/rehearsal_resume.sql`
- [ ] 1.4 Fixture tests pass: `npm run test:rehearsal-resume`
- [ ] 1.5 Type checking passes: `npx astro check`
- [ ] 1.6 Linting passes: `npm run lint`

#### Manual

- [ ] 1.7 Fixture boundaries (30s lease, 24h expiry) match intended behavior

### Phase 2: Idempotent service and routes

#### Automated

- [ ] 2.1 Type checking passes: `npx astro check`
- [ ] 2.2 Linting passes: `npm run lint`
- [ ] 2.3 Build passes: `npm run build`
- [ ] 2.4 Fixture tests still pass: `npm run test:rehearsal-resume`

#### Manual

- [ ] 2.5 Same `clientKey` twice yields one turn; different key while pending returns 409
- [ ] 2.6 Aborted request shows `in_flight` then `needs_reply`; retry replies without adding a turn
- [ ] 2.7 Session backdated 25h reads as expired and no longer blocks a new session

### Phase 3: Resilient chat UI

#### Automated

- [ ] 3.1 Type checking passes: `npx astro check`
- [ ] 3.2 Linting passes: `npm run lint`
- [ ] 3.3 Build passes: `npm run build`
- [ ] 3.4 Smoke test still passes: `npm run smoke`

#### Manual

- [ ] 3.5 Refresh mid-reply: reply appears without clicking, one turn
- [ ] 3.6 Tab close right after sending, reopen: question once, reply arrives or auto-resumes
- [ ] 3.7 Offline send then online: question shows once
- [ ] 3.8 Backgrounded tab returns with current state
- [ ] 3.9 Typed-but-unsent text survives a resync

### Phase 4: End-to-end disruption check and hand-offs

#### Automated

- [ ] 4.1 All checks green together: lint, astro check, build, smoke, test:rehearsal-resume

#### Manual

- [ ] 4.2 Full 8-turn session with refresh, tab close and offline send ends with exactly 8 turns
- [ ] 4.3 Double-click Send produces one turn
- [ ] 4.4 Expired session is read-only, a new session can start, S-06 scoring works on it
- [ ] 4.5 No scenario text in page source, Network tab, state route or logs
