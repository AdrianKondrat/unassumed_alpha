import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, SubmitEvent } from "react";
import { useRehearsalSession } from "@/components/hooks/useRehearsalSession";
import { cn } from "@/lib/utils";
import type { RehearsalEndReason, RehearsalStatus, RehearsalTurn } from "@/types";

interface RehearsalChatProps {
  sessionId: string;
  /** The assumption being rehearsed, in the founder's own kept wording. */
  assumption: string;
  /** Mirrors the server's REHEARSAL_TURN_CAP, passed in so this island does not import server modules. */
  turnCap: number;
  questionMaxLength: number;
  initialTurns: RehearsalTurn[];
  initialStatus: RehearsalStatus;
  initialEndedReason: RehearsalEndReason | null;
}

const ENDED_COPY: Record<RehearsalEndReason, string> = {
  cap: "You used all your questions, so the session ended.",
  user: "You ended the session early.",
};

export function RehearsalChat(props: RehearsalChatProps) {
  const { turnCap, questionMaxLength } = props;
  const { turns, status, endedReason, busy, error, send, retry, end } = useRehearsalSession({
    sessionId: props.sessionId,
    turns: props.initialTurns,
    status: props.initialStatus,
    endedReason: props.initialEndedReason,
  });
  const [question, setQuestion] = useState("");
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const wasBusy = useRef(false);

  const active = status === "active";
  const last = turns.at(-1);
  // A saved question with no reply (and nothing in flight) can only move forward through Retry.
  const needsRetry = active && busy === null && last?.reply === null;
  const used = turns.length;
  const canAsk = active && busy === null && !needsRetry;

  // Return focus to the question box after a send or retry finishes, but never steal it on first paint.
  useEffect(() => {
    if (wasBusy.current && busy === null && canAsk) inputRef.current?.focus();
    wasBusy.current = busy !== null;
  }, [busy, canAsk]);

  // Keep the latest message in view as the conversation grows.
  useEffect(() => {
    if (turns.length > props.initialTurns.length) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns, props.initialTurns.length]);

  async function submit() {
    const text = question.trim();
    if (text === "" || !canAsk) return;
    const outcome = await send(text);
    if (outcome !== "failed") setQuestion("");
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  }

  const announcement =
    busy === "sending" || busy === "retrying"
      ? "Waiting for the practice customer's reply."
      : busy === "ending"
        ? "Ending the session."
        : "";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono-note" data-testid="turn-counter">
          Questions used: {used} of {turnCap}
        </p>
        <span aria-hidden="true" className="flex gap-1">
          {Array.from({ length: turnCap }, (_, i) => (
            <span key={i} className={cn("border-ink size-3 border-2", i < used ? "bg-ink" : "bg-transparent")} />
          ))}
        </span>
      </div>

      {/* Politely announces progress to assistive tech; errors use role="alert" below. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {turns.length === 0 && active && (
        <p className="card-flat text-ink-soft p-5">
          Your practice customer is ready. Ask your first question, the way you would in a real conversation.
        </p>
      )}

      {turns.length > 0 && (
        <ol aria-label="Conversation" className="flex flex-col gap-6">
          {turns.map((turn) => {
            const waiting = turn.reply === null && (busy === "sending" || busy === "retrying") && turn === last;
            return (
              <li key={turn.seq} className="flex flex-col gap-3">
                <div className="card-flat bg-paper-alt ml-auto w-full max-w-[85%] p-4">
                  <p className="label">You · question {turn.seq}</p>
                  <p className="break-words whitespace-pre-wrap">{turn.question}</p>
                </div>
                {turn.reply !== null ? (
                  <div className="card-flat border-l-teal mr-auto w-full max-w-[85%] border-l-[6px] p-4">
                    <p className="label">Practice customer</p>
                    <p className="break-words whitespace-pre-wrap">{turn.reply}</p>
                  </div>
                ) : waiting ? (
                  <div className="card-flat border-l-teal mr-auto w-full max-w-[85%] border-l-[6px] border-dashed p-4">
                    <p className="label">Practice customer</p>
                    <p className="mono-note">Thinking of an answer…</p>
                  </div>
                ) : (
                  <div className="card-flat mr-auto w-full max-w-[85%] border-dashed p-4">
                    <p className="label">Practice customer</p>
                    <p className="mono-note">No answer yet. Your question is saved.</p>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <div ref={endRef} />

      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}

      {needsRetry && (
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            className="btn btn-yellow"
            onClick={() => {
              void retry();
            }}
          >
            Try again
          </button>
          <p className="mono-note">Your question is saved. It doesn&apos;t use up another question.</p>
        </div>
      )}

      {active ? (
        <>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label htmlFor="question" className="label">
              Your next question
            </label>
            <textarea
              id="question"
              ref={inputRef}
              className="input resize-y"
              rows={3}
              maxLength={questionMaxLength}
              value={question}
              disabled={!canAsk}
              onChange={(event) => {
                setQuestion(event.target.value);
              }}
              onKeyDown={onKeyDown}
              aria-describedby="question-hint"
            />
            <div className="flex flex-wrap items-center gap-4">
              <button type="submit" className="btn btn-yellow" disabled={!canAsk || question.trim() === ""}>
                {busy === "sending" ? "Waiting for the reply…" : "Ask"}
              </button>
              <p id="question-hint" className="mono-note">
                {question.length}/{questionMaxLength} · Tip: ask about what actually happened, not what someone might
                do. Press Ctrl or Cmd + Enter to send.
              </p>
            </div>
          </form>

          <div className="border-ink border-t pt-5">
            {confirmingEnd ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-[15px] font-bold">
                  End the session now? You&apos;ve used {used} of {turnCap} questions.
                </p>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busy !== null}
                  onClick={() => {
                    setConfirmingEnd(false);
                    void end();
                  }}
                >
                  Yes, end session
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setConfirmingEnd(false);
                  }}
                >
                  Keep going
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy !== null}
                onClick={() => {
                  setConfirmingEnd(true);
                }}
              >
                End session
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="card p-6">
          <h2 className="disp text-3xl">Session ended</h2>
          <p className="text-ink-soft mt-3">
            {ENDED_COPY[endedReason ?? "user"]} Your transcript is saved above. Next, see how your questions did.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <a href={`/rehearsal/${props.sessionId}/scorecard`} className="btn btn-yellow">
              See your scorecard
            </a>
            <a href="/rehearsal" className="link">
              Back to rehearsal
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
