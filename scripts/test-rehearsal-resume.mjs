// Offline checks for src/lib/services/rehearsal-resume.ts (lease and idle-expiry boundaries, turn
// classification, replay resolution). No network. Run: npm run test:rehearsal-resume
import {
  REPLY_LEASE_MS,
  SESSION_IDLE_EXPIRY_MS,
  classifyTurn,
  isLeaseStale,
  isSessionExpired,
  resolveReplay,
} from "../src/lib/services/rehearsal-resume.ts";

const steps = [];
const step = (name, fn) => steps.push([name, fn]);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

step("the constants match the database (30 s lease, 24 h idle window)", () => {
  assert(REPLY_LEASE_MS === 30_000, `lease is ${REPLY_LEASE_MS}`);
  assert(SESSION_IDLE_EXPIRY_MS === 86_400_000, `idle window is ${SESSION_IDLE_EXPIRY_MS}`);
});

step("a lease is stale only strictly past 30 s (the database uses a strict comparison too)", () => {
  assert(!isLeaseStale({ replyStartedAt: ago(0), now: NOW }), "a brand new lease was stale");
  assert(!isLeaseStale({ replyStartedAt: ago(29_999), now: NOW }), "stale at 29.999 s");
  assert(!isLeaseStale({ replyStartedAt: ago(30_000), now: NOW }), "stale at exactly 30 s");
  assert(isLeaseStale({ replyStartedAt: ago(30_001), now: NOW }), "fresh at 30.001 s");
});

step("no lease, or an unreadable one, counts as stale (nobody is generating the reply)", () => {
  assert(isLeaseStale({ replyStartedAt: null, now: NOW }), "null lease was fresh");
  assert(isLeaseStale({ replyStartedAt: "not a date", now: NOW }), "garbage lease was fresh");
});

step("a session expires only strictly past 24 h of idleness", () => {
  const expired = (lastActivityAt, status = "active") => isSessionExpired({ status, lastActivityAt, now: NOW });
  assert(!expired(ago(0)), "a just-used session expired");
  assert(!expired(ago(SESSION_IDLE_EXPIRY_MS - 60_000)), "expired at 23 h 59 m");
  assert(!expired(ago(SESSION_IDLE_EXPIRY_MS)), "expired at exactly 24 h");
  assert(expired(ago(SESSION_IDLE_EXPIRY_MS + 1)), "not expired just past 24 h");
  assert(expired(ago(SESSION_IDLE_EXPIRY_MS + 60_000)), "not expired at 24 h 1 m");
});

step("an ended session never expires, whatever its age", () => {
  assert(
    !isSessionExpired({ status: "ended", lastActivityAt: ago(10 * SESSION_IDLE_EXPIRY_MS), now: NOW }),
    "ended expired",
  );
});

step("an unreadable activity time never expires a session", () => {
  assert(!isSessionExpired({ status: "active", lastActivityAt: "garbage", now: NOW }), "garbage time expired it");
});

step("a turn with a reply is answered, whatever its lease says", () => {
  assert(classifyTurn({ reply: "Hi", replyStartedAt: null, now: NOW }) === "answered", "no lease");
  assert(classifyTurn({ reply: "Hi", replyStartedAt: ago(1_000), now: NOW }) === "answered", "fresh lease");
  assert(classifyTurn({ reply: "Hi", replyStartedAt: ago(99_000), now: NOW }) === "answered", "stale lease");
});

step("a reply-less turn is in flight under a fresh lease and needs a reply otherwise", () => {
  assert(classifyTurn({ reply: null, replyStartedAt: ago(5_000), now: NOW }) === "in_flight", "fresh lease");
  assert(classifyTurn({ reply: null, replyStartedAt: ago(30_001), now: NOW }) === "needs_reply", "stale lease");
  assert(classifyTurn({ reply: null, replyStartedAt: null, now: NOW }) === "needs_reply", "saved but never claimed");
});

step("an empty-string reply is still a reply (only null means waiting)", () => {
  assert(classifyTurn({ reply: "", replyStartedAt: null, now: NOW }) === "answered", "empty reply treated as waiting");
});

step("a repeated send returns an answered turn, waits on a live request, and resumes an abandoned one", () => {
  assert(resolveReplay({ reply: "Hi", replyStartedAt: null, now: NOW }) === "answered", "answered");
  assert(resolveReplay({ reply: null, replyStartedAt: ago(2_000), now: NOW }) === "wait", "in flight");
  assert(resolveReplay({ reply: null, replyStartedAt: ago(45_000), now: NOW }) === "resume", "abandoned");
  assert(resolveReplay({ reply: null, replyStartedAt: null, now: NOW }) === "resume", "never claimed");
});

let failed = 0;
for (const [name, fn] of steps) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${steps.length} checks passed`);
process.exit(failed ? 1 : 0);
