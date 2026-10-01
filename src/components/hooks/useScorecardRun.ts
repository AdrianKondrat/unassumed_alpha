import { useCallback, useEffect, useRef, useState } from "react";

export type ScorecardPhase = "working" | "failed";

interface ApiBody {
  status?: "ready" | "insufficient" | "failed" | "in_progress";
  message?: string;
  error?: string;
}

/** Another request holds the scoring lease: ask again this often, for at most POLL_LIMIT asks (about 40 s). */
const POLL_INTERVAL_MS = 3000;
const POLL_LIMIT = 12;

const COPY = {
  network: "We couldn't reach the server. Nothing was lost. Check your connection and try again.",
  signedOut: "You've been signed out. Sign in again to see your scorecard.",
  slow: "Scoring is taking longer than expected. Nothing was lost. Try again.",
  fallback: "Something went wrong. Nothing was lost. Try again.",
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function post(url: string): Promise<{ status: number; body: ApiBody } | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = (await response.json().catch(() => ({}))) as ApiBody;
    return { status: response.status, body };
  } catch {
    return null;
  }
}

/**
 * Drives scoring for one ended session. The server is idempotent, so asking is always safe: a finished scorecard
 * comes straight back, a fresh lease held elsewhere answers `in_progress` (we wait and ask again), and a failure
 * is a saved state the founder retries by hand. When scoring finishes the page reloads so the scorecard itself is
 * rendered on the server from RLS-scoped reads; this hook never carries scorecard content.
 */
export function useScorecardRun(options: { sessionId: string; autoStart: boolean; initialMessage: string | null }) {
  const { sessionId, autoStart } = options;
  const [phase, setPhase] = useState<ScorecardPhase>(autoStart ? "working" : "failed");
  const [message, setMessage] = useState<string | null>(autoStart ? null : options.initialMessage);
  const running = useRef(false);
  const mounted = useRef(true);

  const run = useCallback(async (): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setPhase("working");
    setMessage(null);

    // One pass of the loop: a final answer for the page, or null to ask again.
    const ask = async (): Promise<{ failed: string } | "finished" | null> => {
      const result = await post(`/api/rehearsal/sessions/${sessionId}/score`);
      if (!result) return { failed: COPY.network };
      if (result.status === 401) return { failed: COPY.signedOut };
      if (result.status !== 200) return { failed: result.body.message ?? COPY.fallback };
      switch (result.body.status) {
        case "ready":
        case "insufficient":
          return "finished";
        case "in_progress":
          return null;
        case "failed":
        default:
          return { failed: result.body.message ?? COPY.fallback };
      }
    };

    try {
      let outcome: Awaited<ReturnType<typeof ask>> = null;
      for (let attempt = 0; attempt < POLL_LIMIT && outcome === null; attempt++) {
        if (attempt > 0) await sleep(POLL_INTERVAL_MS);
        if (!mounted.current) return;
        outcome = await ask();
      }
      if (!mounted.current) return;
      if (outcome === "finished") {
        // Stay in the "working" phase while the server renders the finished page.
        window.location.reload();
      } else {
        setPhase("failed");
        setMessage(outcome === null ? COPY.slow : outcome.failed);
      }
    } finally {
      running.current = false;
    }
  }, [sessionId]);

  useEffect(() => {
    mounted.current = true;
    if (autoStart) void run();
    return () => {
      mounted.current = false;
    };
    // Starts once per mount; `run` is stable for a given session.
  }, [autoStart, run]);

  return { phase, message, retry: run };
}
