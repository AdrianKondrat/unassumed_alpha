import { useScorecardRun } from "@/components/hooks/useScorecardRun";
import { cn } from "@/lib/utils";

// Full class names (not computed) so Tailwind sees them; a style attribute would need CSP 'unsafe-inline'.
const PULSE_DELAY = [
  "[animation-delay:0ms]",
  "[animation-delay:150ms]",
  "[animation-delay:300ms]",
  "[animation-delay:450ms]",
  "[animation-delay:600ms]",
];

interface ScorecardStatusProps {
  sessionId: string;
  /** True when no attempt has failed yet, so the island starts scoring as soon as the page loads. */
  autoStart: boolean;
  /** Static failure copy for a scorecard that already failed; null otherwise. */
  initialMessage: string | null;
}

/** Shown while a scorecard is missing, in flight or failed. A finished scorecard is rendered by the page itself. */
export function ScorecardStatus(props: ScorecardStatusProps) {
  const { phase, message, retry } = useScorecardRun(props);

  if (phase === "failed") {
    return (
      <div className="card p-6">
        <h2 className="disp text-3xl">We couldn&apos;t score this one</h2>
        <p role="alert" className="notice notice-error mt-4">
          {message}
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <button
            type="button"
            className="btn btn-yellow"
            onClick={() => {
              void retry();
            }}
          >
            Try again
          </button>
          <a href={`/rehearsal/${props.sessionId}`} className="link">
            View transcript
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="card p-6">
      <h2 className="disp text-3xl">Scoring your questions</h2>
      <p role="status" aria-live="polite" className="text-ink-soft mt-3">
        Scoring your questions. This can take up to 30 seconds. Please keep this page open.
      </p>
      <span aria-hidden="true" className="mt-5 flex gap-1">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className={cn("border-ink bg-yellow size-3 animate-pulse border-2", PULSE_DELAY[i])} />
        ))}
      </span>
    </div>
  );
}
