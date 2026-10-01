import { useCallback, useEffect, useRef, useState } from "react";
import type { RehearsalEndReason, RehearsalStatus, RehearsalTurn } from "@/types";

export type Busy = "sending" | "retrying" | "ending" | null;

/** "sent" and "saved" both put the question in the transcript; "failed" leaves it for the founder to resend. */
export type SendOutcome = "sent" | "saved" | "failed";

/** What is happening to the latest unanswered turn: another request is generating it, or nobody is. */
export type Pending = "in_flight" | "needs_reply";

interface StateTurnBody {
  seq: number;
  question: string;
  reply: string | null;
  clientKey: string;
}

interface ApiBody {
  turn?: RehearsalTurn;
  ended?: boolean;
  /** `true` on a replayed send whose reply is still being generated (turns route); the state route sends the Pending value. */
  pending?: boolean | Pending | null;
  error?: string;
  message?: string;
  // The resume state (GET).
  status?: RehearsalStatus;
  endedReason?: RehearsalEndReason | null;
  turns?: StateTurnBody[];
}

/** While a reply is generated elsewhere (another tab, a request that survived a refresh) ask this often. */
const POLL_INTERVAL_MS = 2000;
/** How long the "Reconnected" note stays up. */
const NOTICE_MS = 6000;

const COPY = {
  network: "We couldn't reach the server. Check your connection and try again.",
  unconfirmed:
    "We couldn't confirm that question was sent. Sending it again is safe: it will not be counted twice. We'll also check as soon as you're back online.",
  signedOut: "You've been signed out. Sign in again to carry on.",
  fallback: "Something went wrong. Try again.",
  reconnected: "Reconnected. Your conversation is up to date.",
};

/** Sends or fetches JSON and returns the status and body, or null when the request never completed. */
async function call(
  url: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<{ status: number; body: ApiBody } | null> {
  try {
    const response = await fetch(url, {
      method,
      ...(method === "POST"
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : { cache: "no-store" as const }),
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

const sameTurns = (a: RehearsalTurn[], b: RehearsalTurn[]) =>
  a.length === b.length &&
  a.every((t, i) => t.seq === b[i].seq && t.question === b[i].question && t.reply === b[i].reply);

export function useRehearsalSession(initial: {
  sessionId: string;
  turns: RehearsalTurn[];
  status: RehearsalStatus;
  endedReason: RehearsalEndReason | null;
  pending: Pending | null;
  /** Called when a resync finds the send we could not confirm in the transcript, with the text that was sent. */
  onRecovered?: (text: string) => void;
}) {
  const { sessionId } = initial;
  const [turns, setTurns] = useState<RehearsalTurn[]>(initial.turns);
  const [status, setStatus] = useState<RehearsalStatus>(initial.status);
  const [endedReason, setEndedReason] = useState<RehearsalEndReason | null>(initial.endedReason);
  const [pending, setPending] = useState<Pending | null>(initial.pending);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Refs, not state: two clicks in the same tick must not both pass the guard, and effects/listeners need the latest.
  const inFlight = useRef(false);
  const turnsRef = useRef(turns);
  /** One idempotency key per question: held until the question is saved, so every re-send of it carries the same key. */
  const sendKey = useRef<{ text: string; key: string } | null>(null);
  /** Turns we already tried to resume on our own; a failed resume then waits for the founder's Try again. */
  const autoResumed = useRef(new Set<number>());
  const onRecoveredRef = useRef(initial.onRecovered);
  useEffect(() => {
    onRecoveredRef.current = initial.onRecovered;
  }, [initial.onRecovered]);

  const base = `/api/rehearsal/sessions/${sessionId}`;

  // Listeners and the resync callback read the latest turns through a ref, updated after each render.
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  /** Pulls the server's view of the session and replaces local state with it. Never touches the founder's typed text. */
  const resync = useCallback(
    async (quiet: boolean): Promise<void> => {
      // A local send, retry or end is already talking to the server; its own response is the freshest state.
      const localRequestActive = () => inFlight.current;
      if (localRequestActive()) return;
      const result = await call(base, "GET");
      if (localRequestActive() || result?.status !== 200 || !result.body.turns) return;
      const body = result.body;
      const serverTurns: RehearsalTurn[] = (body.turns ?? []).map(({ seq, question, reply }) => ({
        seq,
        question,
        reply,
      }));

      const changed = !sameTurns(turnsRef.current, serverTurns);
      setTurns(serverTurns);
      if (body.status) setStatus(body.status);
      setEndedReason(body.endedReason ?? null);
      setPending(body.pending === "in_flight" || body.pending === "needs_reply" ? body.pending : null);

      const held = sendKey.current;
      if (held && (body.turns ?? []).some((t) => t.clientKey === held.key)) {
        // The send we could not confirm did reach the server: it is in the transcript now, so nothing to resend.
        sendKey.current = null;
        onRecoveredRef.current?.(held.text);
        setError(null);
      }
      if (changed && !quiet) setNotice(COPY.reconnected);
    },
    [base],
  );

  /** Applies what a failed response says about the session, and returns the message to show. */
  const explain = useCallback(
    (httpStatus: number, body: ApiBody): string => {
      if (httpStatus === 401) return COPY.signedOut;
      if (body.error === "not_active" || body.error === "cap_reached") {
        setStatus("ended");
        // The real reason (cap, expired, ended in another tab) comes from the server's state.
        setEndedReason((current) => current ?? (body.error === "cap_reached" ? "cap" : "user"));
        void resync(true);
      }
      if (body.error === "reply_pending") void resync(true);
      return body.message ?? COPY.fallback;
    },
    [resync],
  );

  const send = useCallback(
    async (question: string): Promise<SendOutcome> => {
      if (inFlight.current) return "failed";
      inFlight.current = true;
      setBusy("sending");
      setError(null);
      setNotice(null);

      // Same text again after a failed or unconfirmed send keeps its key, so the server returns the saved turn
      // instead of adding a second one. New text gets a new key.
      const held = sendKey.current;
      const key = held?.text === question ? held.key : crypto.randomUUID();
      sendKey.current = { text: question, key };

      const optimistic: RehearsalTurn = { seq: turns.length + 1, question, reply: null };
      setTurns((current) => [...current, optimistic]);

      const result = await call(`${base}/turns`, "POST", { question, clientKey: key });
      inFlight.current = false;
      setBusy(null);

      if (!result) {
        setTurns((current) => current.filter((t) => t.seq !== optimistic.seq));
        setError(COPY.unconfirmed);
        // The key is kept. If the request reached the server, the next resync finds it and clears this note.
        if (typeof navigator === "undefined" || navigator.onLine) void resync(true);
        return "failed";
      }
      if (result.status === 200 && result.body.turn) {
        const turn = result.body.turn;
        sendKey.current = null;
        setTurns((current) => upsert(current, turn));
        // pending: another request is still generating this reply (a replay); wait for it instead of resending.
        setPending(result.body.pending ? "in_flight" : null);
        if (result.body.ended) {
          setStatus("ended");
          setEndedReason("cap");
        }
        return "sent";
      }
      if (result.body.turn) {
        // The question was saved but the reply failed: keep it in the transcript with a Retry.
        const turn = result.body.turn;
        sendKey.current = null;
        autoResumed.current.add(turn.seq);
        setTurns((current) => upsert(current, turn));
        setPending("needs_reply");
        setError(explain(result.status, result.body));
        return "saved";
      }
      setTurns((current) => current.filter((t) => t.seq !== optimistic.seq));
      if (result.body.error !== "reply_pending") sendKey.current = null;
      setError(explain(result.status, result.body));
      return "failed";
    },
    [base, explain, resync, turns.length],
  );

  const retry = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("retrying");
    setError(null);
    setNotice(null);

    const result = await call(`${base}/retry`, "POST", {});
    inFlight.current = false;
    setBusy(null);

    if (!result) {
      setError(COPY.network);
      return;
    }
    if (result.status === 200 && result.body.turn) {
      const turn = result.body.turn;
      setTurns((current) => upsert(current, turn));
      setPending(result.body.pending ? "in_flight" : null);
      if (result.body.ended) {
        setStatus("ended");
        setEndedReason("cap");
      }
      return;
    }
    if (result.body.error === "nothing_to_retry") {
      // Someone else (another tab, an earlier request) answered it; show what the server has.
      setPending(null);
      void resync(true);
      return;
    }
    setPending("needs_reply");
    setError(explain(result.status, result.body));
  }, [base, explain, resync]);

  const end = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("ending");
    setError(null);
    setNotice(null);

    const result = await call(`${base}/end`, "POST", {});
    inFlight.current = false;
    setBusy(null);

    if (!result) {
      setError(COPY.network);
      return;
    }
    if (result.status === 200) {
      setStatus("ended");
      setEndedReason((current) => current ?? "user");
      void resync(true);
      return;
    }
    setError(explain(result.status, result.body));
  }, [base, explain, resync]);

  // Come back in sync when the tab is foregrounded, the network returns, or the page is restored from the
  // back/forward cache. The server is the source of truth for the transcript.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void resync(false);
    };
    const onOnline = () => {
      void resync(false);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void resync(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [resync]);

  // While a reply is being generated by another request, ask again until it lands (or its lease goes stale).
  useEffect(() => {
    if (pending !== "in_flight") return;
    const timer = setInterval(() => {
      void resync(true);
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [pending, resync]);

  // A reply nobody is generating (its request died with the tab) resumes by itself, once per turn. If that fails,
  // the visible Try again button takes over.
  const lastSeq = turns.at(-1)?.seq;
  useEffect(() => {
    if (pending !== "needs_reply" || status !== "active" || busy !== null || lastSeq === undefined) return;
    if (autoResumed.current.has(lastSeq)) return;
    autoResumed.current.add(lastSeq);
    void retry();
  }, [pending, status, busy, lastSeq, retry]);

  // The "Reconnected" note is brief.
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  return { turns, status, endedReason, pending, busy, error, notice, send, retry, end };
}
