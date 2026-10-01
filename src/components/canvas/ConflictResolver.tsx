import { useEffect, useRef } from "react";

interface ConflictResolverProps {
  /** The founder's unsaved wording. */
  mine: string;
  /** The wording someone else saved first. */
  saved: string;
  busy: boolean;
  error: string | null;
  onKeepMine: () => void;
  onUseSaved: () => void;
}

/** Side by side "Your edit" and "Saved version", shown inline when a save lost a race (FR-008). */
export function ConflictResolver({ mine, saved, busy, error, onKeepMine, onUseSaved }: ConflictResolverProps) {
  const firstButton = useRef<HTMLButtonElement>(null);

  // Move focus into the resolver so keyboard and screen-reader users land on the decision.
  useEffect(() => {
    firstButton.current?.focus();
  }, []);

  return (
    <div role="alert" className="border-red bg-paper-alt flex flex-col gap-3 border-2 p-3">
      <p className="text-[15px] font-bold">This claim changed while you were editing it. Which wording do you want?</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="card-flat p-3">
          <p className="label">Your edit</p>
          <p className="text-[15px] break-words whitespace-pre-wrap">{mine}</p>
        </div>
        <div className="card-flat p-3">
          <p className="label">Saved version</p>
          <p className="text-[15px] break-words whitespace-pre-wrap">{saved}</p>
        </div>
      </div>
      {error && <p className="notice notice-error">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <button ref={firstButton} type="button" className="btn btn-yellow btn-sm" disabled={busy} onClick={onKeepMine}>
          Keep mine
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onUseSaved}>
          Use saved
        </button>
      </div>
    </div>
  );
}
