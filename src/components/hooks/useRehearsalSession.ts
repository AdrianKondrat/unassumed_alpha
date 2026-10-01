import { useCallback, useRef, useState } from "react";
import type { RehearsalEndReason, RehearsalStatus, RehearsalTurn } from "@/types";

export type Busy = "sending" | "retrying" | "ending" | null;

/** "sent" and "saved" both put the question in the transcript; "failed" leaves it for the founder to resend. */
export type SendOutcome = "sent" | "saved" | "failed";

interface ApiBody {
  turn?: RehearsalTurn;
  ended?: boolean;
  error?: string;
  message?: string;
}

const COPY = {
  network: "We couldn't reach the server. Check your connection and try again.",
  unconfirmed:
    "We couldn't confirm that question was sent. Reload the page to see where the conversation stands before asking again.",
  signedOut: "You've been signed out. Sign in again to carry on.",
  fallback: "Something went wrong. Try again.",
};

/** POSTs JSON and returns the status and body, or null when the request never completed. */
async function post(url: string, body: unknown): Promise<{ status: number; body: ApiBody } | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => ({}))) as ApiBody;
    return { status: response.status, body: parsed };
  } catch {
    return null;
  }
}

/** Replaces the turn with the same seq, or appends it. */
function upsert(turns: RehearsalTurn[], turn: RehearsalTurn): RehearsalTurn[] {
  return turns.some((t) => t.seq === turn.seq)
    ? turns.map((t) => (t.seq === turn.seq ? turn : t))
    : [...turns, turn].sort((a, b) => a.seq - b.seq);
}

export function useRehearsalSession(initial: {
  sessionId: string;
  turns: RehearsalTurn[];
  status: RehearsalStatus;
  endedReason: RehearsalEndReason | null;
}) {
  const { sessionId } = initial;
  const [turns, setTurns] = useState<RehearsalTurn[]>(initial.turns);
  const [status, setStatus] = useState<RehearsalStatus>(initial.status);
  const [endedReason, setEndedReason] = useState<RehearsalEndReason | null>(initial.endedReason);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state: two clicks in the same tick must not both pass the guard.
  const inFlight = useRef(false);

  const base = `/api/rehearsal/sessions/${sessionId}`;

  /** Applies what a failed response says about the session, and returns the message to show. */
  const explain = useCallback((status: number, body: ApiBody): string => {
    if (status === 401) return COPY.signedOut;
    if (body.error === "not_active") {
      setStatus("ended");
      setEndedReason((current) => current ?? "user");
    }
    if (body.error === "cap_reached") {
      setStatus("ended");
      setEndedReason("cap");
    }
    return body.message ?? COPY.fallback;
  }, []);

  const send = useCallback(
    async (question: string): Promise<SendOutcome> => {
      if (inFlight.current) return "failed";
      inFlight.current = true;
      setBusy("sending");
      setError(null);
      const optimistic: RehearsalTurn = { seq: turns.length + 1, question, reply: null };
      setTurns((current) => [...current, optimistic]);

      const result = await post(`${base}/turns`, { question });
      inFlight.current = false;
      setBusy(null);

      if (!result) {
        setTurns((current) => current.filter((t) => t.seq !== optimistic.seq));
        setError(COPY.unconfirmed);
        return "failed";
      }
      if (result.status === 200 && result.body.turn) {
        const turn = result.body.turn;
        setTurns((current) => upsert(current, turn));
        if (result.body.ended) {
          setStatus("ended");
          setEndedReason("cap");
        }
        return "sent";
      }
      if (result.body.turn) {
        // The question was saved but the reply failed: keep it in the transcript with a Retry.
        const turn = result.body.turn;
        setTurns((current) => upsert(current, turn));
        setError(explain(result.status, result.body));
        return "saved";
      }
      setTurns((current) => current.filter((t) => t.seq !== optimistic.seq));
      setError(explain(result.status, result.body));
      return "failed";
    },
    [base, explain, turns.length],
  );

  const retry = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("retrying");
    setError(null);

    const result = await post(`${base}/retry`, {});
    inFlight.current = false;
    setBusy(null);

    if (!result) {
      setError(COPY.network);
      return;
    }
    if (result.status === 200 && result.body.turn) {
      const turn = result.body.turn;
      setTurns((current) => upsert(current, turn));
      if (result.body.ended) {
        setStatus("ended");
        setEndedReason("cap");
      }
      return;
    }
    setError(explain(result.status, result.body));
  }, [base, explain]);

  const end = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("ending");
    setError(null);

    const result = await post(`${base}/end`, {});
    inFlight.current = false;
    setBusy(null);

    if (!result) {
      setError(COPY.network);
      return;
    }
    if (result.status === 200) {
      setStatus("ended");
      setEndedReason((current) => current ?? "user");
      return;
    }
    setError(explain(result.status, result.body));
  }, [base, explain]);

  return { turns, status, endedReason, busy, error, send, retry, end };
}
