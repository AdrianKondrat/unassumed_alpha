// The scoring attempt loop, with the model call and the clock injected so the deadline logic is testable
// offline (scripts/test-scorecard.mjs). Pure: no `astro:*`, no `@/`, relative imports only.
//
// Budget: the founder waits on this request, so one shared deadline covers everything. One attempt gets at most
// 12 s; a second attempt only starts if at least 6 s of the 25 s budget remain, so the worst case stays inside
// the product's ~30 s expectation instead of F-02's default 25 s timeout plus a retry (~50 s).
import { buildScoreMessages, parseScore } from "./scorecard.ts";
import type { ParsedScore, ScoreTurn } from "./scorecard.ts";
import type { AIMessage } from "../ai-request.ts";

export const SCORE_DEADLINE_MS = 25_000;
export const SCORE_ATTEMPT_TIMEOUT_MS = 12_000;
export const SCORE_MIN_RETRY_BUDGET_MS = 6_000;
export const SCORE_MAX_ATTEMPTS = 2;

export type ScoreErrorKind = "timeout" | "ai_failed" | "invalid_output";

/** What the injected model call reports back (a thin view of AIResult). */
export type ModelReply =
  | { ok: true; text: string; model: string }
  | { ok: false; kind: "timeout" | "rate_limited" | "provider_error" | "invalid_response" };

export type ScoringOutcome =
  | { ok: true; score: ParsedScore; model: string; attempts: number }
  | {
      ok: false;
      errorKind: ScoreErrorKind;
      attempts: number;
      /** Parser reasons (paths and positions only, never text) for the server log. */
      reasons: string[];
    };

export async function runScoring(params: {
  turns: readonly ScoreTurn[];
  ask: (messages: AIMessage[], timeoutMs: number) => Promise<ModelReply>;
  now: () => number;
}): Promise<ScoringOutcome> {
  const { turns, ask, now } = params;
  const started = now();
  const messages = buildScoreMessages(turns);
  const reasons: string[] = [];
  let errorKind: ScoreErrorKind = "ai_failed";
  let attempts = 0;

  while (attempts < SCORE_MAX_ATTEMPTS) {
    const remaining = SCORE_DEADLINE_MS - (now() - started);
    if (attempts > 0 && remaining < SCORE_MIN_RETRY_BUDGET_MS) break;
    attempts++;

    const reply = await ask(messages, Math.min(SCORE_ATTEMPT_TIMEOUT_MS, Math.max(remaining, 1_000)));
    if (!reply.ok) {
      errorKind = reply.kind === "timeout" ? "timeout" : "ai_failed";
      continue;
    }

    const parsed = parseScore(reply.text, turns);
    if (parsed.ok) return { ok: true, score: parsed.score, model: reply.model, attempts };
    errorKind = "invalid_output";
    reasons.push(parsed.reason);
  }
  return { ok: false, errorKind, attempts, reasons };
}
