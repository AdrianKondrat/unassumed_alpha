import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ClaimEditor } from "@/components/hooks/useClaimEditor";
import type { CanvasBlockKey } from "@/types";

interface AddClaimProps {
  block: CanvasBlockKey;
  label: string;
  editor: ClaimEditor;
  maxLength: number;
  full: boolean;
}

/** "Add a claim" for one block: a button that opens an inline box. Nothing is saved until the founder presses Add. */
export function AddClaim({ block, label, editor, maxLength, full }: AddClaimProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (open) box.current?.focus();
    else if (returnFocus.current) {
      trigger.current?.focus();
      returnFocus.current = false;
    }
  }, [open]);

  function close() {
    returnFocus.current = true;
    setDraft("");
    setError(null);
    setOpen(false);
  }

  async function submit() {
    const text = draft.replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (text === "") {
      setError("Write a claim first.");
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await editor.add(block, text);
    setBusy(false);
    if (outcome.kind === "added") close();
    else setError(outcome.message);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  }

  if (!open) {
    return full ? (
      <p className="mono-note">This block is full. Delete a claim to add another.</p>
    ) : (
      <button
        ref={trigger}
        type="button"
        className="btn btn-ghost btn-sm self-start"
        onClick={() => {
          setOpen(true);
        }}
      >
        Add a claim<span className="sr-only"> to {label}</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`add-${block}`} className="label">
        New claim for {label}
      </label>
      <textarea
        id={`add-${block}`}
        ref={box}
        className="input resize-y"
        rows={3}
        maxLength={maxLength}
        value={draft}
        disabled={busy}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={onKeyDown}
        aria-describedby={`add-hint-${block}`}
      />
      <p id={`add-hint-${block}`} className="mono-note">
        {draft.length}/{maxLength} · One short claim. Escape cancels · Ctrl or Cmd + Enter adds
      </p>
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="btn btn-yellow btn-sm"
          disabled={busy}
          onClick={() => {
            void submit();
          }}
        >
          {busy ? "Adding…" : "Add"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
    </div>
  );
}
