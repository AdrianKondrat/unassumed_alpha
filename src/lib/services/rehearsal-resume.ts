// Pure rules for resuming a rehearsal session: when a reply lease is stale, when a session has gone idle, and what
// a turn's state is. No `astro:*`, no `@/`, relative imports only, so scripts/test-rehearsal-resume.mjs can import
// it with `--experimental-strip-types`. Time is always passed in, never read here.
//
// The database is the authority on both clocks (it decides claims and expiry with its own clock under row locks,
// see supabase/migrations/20261001100600_rehearsal_resume.sql). These functions mirror its boundaries so the app
// can classify what it reads without a round trip; if the clocks differ by a second the worst outcome is one extra
// poll or a claim the database refuses.

/** A reply being generated holds a lease this long. Mirrors `c_lease` in `rehearsal_claim_reply`. */
export const REPLY_LEASE_MS = 30_000;

/** An active session untouched for this long ends as 'expired'. Mirrors the 24 hours in the migration. */
export const SESSION_IDLE_EXPIRY_MS = 24 * 60 * 60 * 1000;

export type TurnState = "answered" | "in_flight" | "needs_reply";

/** What a founder's client should do about the latest turn: nothing, wait for another request, or resume it. */
export type PendingState = Exclude<TurnState, "answered">;

const elapsedMs = (from: string | null, now: number): number | null => {
  if (from === null) return null;
  const started = Date.parse(from);
  return Number.isNaN(started) ? null : now - started;
};

/** True when nobody holds a live lease: never claimed, an unreadable timestamp, or held for more than the lease. */
export function isLeaseStale(params: { replyStartedAt: string | null; now: number }): boolean {
  const elapsed = elapsedMs(params.replyStartedAt, params.now);
  return elapsed === null || elapsed > REPLY_LEASE_MS;
}

/** True only for an ACTIVE session idle for more than 24 hours. An ended session never expires. */
export function isSessionExpired(params: { status: string; lastActivityAt: string; now: number }): boolean {
  if (params.status !== "active") return false;
  const elapsed = elapsedMs(params.lastActivityAt, params.now);
  return elapsed !== null && elapsed > SESSION_IDLE_EXPIRY_MS;
}

/** answered: has a reply. in_flight: another request holds a fresh lease. needs_reply: nobody is generating it. */
export function classifyTurn(params: { reply: string | null; replyStartedAt: string | null; now: number }): TurnState {
  if (params.reply !== null) return "answered";
  return isLeaseStale(params) ? "needs_reply" : "in_flight";
}

/**
 * What a repeated send (same key) should do with the turn it already saved: return it, wait for the request that
 * is generating its reply, or resume the generation because that request is gone.
 */
export function resolveReplay(params: {
  reply: string | null;
  replyStartedAt: string | null;
  now: number;
}): "answered" | "wait" | "resume" {
  const state = classifyTurn(params);
  if (state === "answered") return "answered";
  return state === "in_flight" ? "wait" : "resume";
}
