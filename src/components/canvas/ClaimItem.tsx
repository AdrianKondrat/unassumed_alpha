import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ClaimEditor } from "@/components/hooks/useClaimEditor";
import { cn } from "@/lib/utils";
import type { PublicClaim } from "@/types";
import { ConflictResolver } from "./ConflictResolver";

interface ClaimItemProps {
  claim: PublicClaim;
  editor: ClaimEditor;
  maxLength: number;
}

type Mode =
  | { kind: "view" }
  | { kind: "edit"; draft: string }
  | { kind: "conflict"; mine: string; saved: PublicClaim }
  | { kind: "gone"; mine: string }
  | { kind: "confirm-delete" };

const short = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

export function ClaimItem({ claim, editor, maxLength }: ClaimItemProps) {
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const editBox = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"edit" | null>(null);

  const isAi = claim.origin === "ai_draft";

  // Focus follows the mode: into the box when editing starts, back to Edit when it ends.
  useEffect(() => {
    if (mode.kind === "edit") editBox.current?.focus();
    if (mode.kind === "view" && focusAfter.current === "edit") {
      editButton.current?.focus();
      focusAfter.current = null;
    }
  }, [mode.kind]);

  function startEdit() {
    setError(null);
    setNote(null);
    setMode({ kind: "edit", draft: claim.text });
  }

  function closeEdit() {
    focusAfter.current = "edit";
    setError(null);
    setMode({ kind: "view" });
  }

  async function submit(text: string, expectedRevision: number) {
    const trimmed = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (trimmed === "") {
      setError("Write a claim first, or use Delete to remove it.");
      return;
    }
    if (trimmed === claim.text && expectedRevision === claim.revision) {
      closeEdit();
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await editor.save(claim.id, trimmed, expectedRevision);
    setBusy(false);
    switch (outcome.kind) {
      case "saved":
        closeEdit();
        break;
      case "conflict":
        setMode({ kind: "conflict", mine: trimmed, saved: outcome.current });
        break;
      case "gone":
        setMode({ kind: "gone", mine: trimmed });
        break;
      case "error":
        setError(outcome.message);
        break;
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setError(null);
    const outcome = await editor.remove(claim.id, claim.revision);
    setBusy(false);
    if (outcome.kind === "conflict") {
      setMode({ kind: "view" });
      setNote("This claim was changed elsewhere. Check the new wording, then delete it again if you still want to.");
    } else if (outcome.kind === "error") {
      setError(outcome.message);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mode.kind !== "edit") return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeEdit();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit(mode.draft, claim.revision);
    }
  }

  return (
    <li
      className={cn(
        "flex flex-col gap-2 border-l-4 py-1 pl-3",
        isAi ? "border-ink-mute border-dashed" : "border-teal border-solid",
      )}
    >
      {mode.kind === "edit" && (
        <div className="flex flex-col gap-2">
          <label htmlFor={`claim-${claim.id}`} className="sr-only">
            Edit claim
          </label>
          <textarea
            id={`claim-${claim.id}`}
            ref={editBox}
            className="input resize-y"
            rows={3}
            maxLength={maxLength}
            value={mode.draft}
            disabled={busy}
            onChange={(event) => {
              setMode({ kind: "edit", draft: event.target.value });
            }}
            onKeyDown={onKeyDown}
            aria-describedby={`claim-hint-${claim.id}`}
          />
          <p id={`claim-hint-${claim.id}`} className="mono-note">
            {mode.draft.length}/{maxLength} · Escape cancels · Ctrl or Cmd + Enter saves
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
                void submit(mode.draft, claim.revision);
              }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={closeEdit}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode.kind === "conflict" && (
        <ConflictResolver
          mine={mode.mine}
          saved={mode.saved.text}
          busy={busy}
          error={error}
          onKeepMine={() => {
            // Re-save the founder's wording against the revision that beat it.
            void submit(mode.mine, mode.saved.revision);
          }}
          onUseSaved={() => {
            editor.upsert(mode.saved);
            closeEdit();
          }}
        />
      )}

      {mode.kind === "gone" && (
        <div role="alert" className="border-red bg-paper-alt flex flex-col gap-3 border-2 p-3">
          <p className="text-[15px] font-bold">This claim was deleted elsewhere. Your edit is below.</p>
          <p className="card-flat p-3 text-[15px] break-words whitespace-pre-wrap">{mode.mine}</p>
          {error && <p className="notice notice-error">{error}</p>}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="btn btn-yellow btn-sm"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  const outcome = await editor.add(claim.block, mode.mine);
                  setBusy(false);
                  if (outcome.kind === "added") editor.drop(claim.id);
                  else setError(outcome.message);
                })();
              }}
            >
              Add my wording as a new claim
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => {
                editor.drop(claim.id);
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {(mode.kind === "view" || mode.kind === "confirm-delete") && (
        <>
          <p className="text-[15px] leading-snug break-words whitespace-pre-wrap">{claim.text}</p>
          <div className="flex flex-wrap items-center gap-3">
            {isAi ? (
              <span className="tag tag-yellow" title="Written by the AI as a starting point. Review it and change it.">
                <span className="sr-only">Written by: </span>AI draft
              </span>
            ) : (
              <span className="tag tag-teal">
                <span className="sr-only">Written by: </span>You
              </span>
            )}
            {mode.kind === "view" && (
              <>
                <button
                  ref={editButton}
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`Edit claim: ${short(claim.text)}`}
                  onClick={startEdit}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`Delete claim: ${short(claim.text)}`}
                  onClick={() => {
                    setNote(null);
                    setError(null);
                    setMode({ kind: "confirm-delete" });
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </div>
          {note && <p className="notice notice-info">{note}</p>}
          {mode.kind === "confirm-delete" && (
            <div className="flex flex-col gap-2">
              <p className="text-[15px] font-bold">
                Delete this claim? Any assumption drawn from it keeps its wording but loses the link to it.
              </p>
              {error && (
                <p role="alert" className="notice notice-error">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busy}
                  onClick={() => {
                    void confirmDelete();
                  }}
                >
                  {busy ? "Deleting…" : "Yes, delete"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setMode({ kind: "view" });
                  }}
                >
                  Keep it
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </li>
  );
}
