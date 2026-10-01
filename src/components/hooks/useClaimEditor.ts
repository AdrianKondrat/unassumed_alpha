import { useCallback, useRef, useState } from "react";
import type { CanvasBlockKey, PublicClaim } from "@/types";

/** Outcome of saving new text. `conflict` carries the saved claim; `gone` means it was deleted elsewhere. */
export type SaveOutcome =
  | { kind: "saved" }
  | { kind: "conflict"; current: PublicClaim }
  | { kind: "gone" }
  | { kind: "error"; message: string };

export type AddOutcome = { kind: "added" } | { kind: "error"; message: string };

export type RemoveOutcome =
  { kind: "removed" } | { kind: "conflict"; current: PublicClaim } | { kind: "error"; message: string };

interface ApiBody {
  claim?: PublicClaim;
  current?: PublicClaim;
  deleted?: boolean;
  error?: string;
  message?: string;
}

const COPY = {
  network: "We couldn't reach the server. Your text is still here. Check your connection and try again.",
  signedOut: "You've been signed out. Sign in again to save.",
  fallback: "Something went wrong. Your text is still here. Try again.",
};

async function call(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
): Promise<{ status: number; body: ApiBody } | null> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => ({}))) as ApiBody;
    return { status: response.status, body: parsed };
  } catch {
    return null;
  }
}

const failure = (status: number, body: ApiBody): string =>
  status === 401 ? COPY.signedOut : (body.message ?? COPY.fallback);

/**
 * Claim list state and the three writes. Every write sends the revision the caller loaded, and every successful
 * response replaces the stored claim with the server's (so the founder's own consecutive saves never conflict with
 * each other). A 409 hands back the saved claim and changes nothing locally: the caller decides what the founder sees.
 */
export function useClaimEditor(initial: PublicClaim[]) {
  const [claims, setClaims] = useState<PublicClaim[]>(initial);
  const [announcement, setAnnouncement] = useState("");
  // A ref, not state: two clicks in the same tick must not both pass the guard.
  const inFlight = useRef(new Set<string>());

  const upsert = useCallback((claim: PublicClaim) => {
    setClaims((current) =>
      current.some((c) => c.id === claim.id)
        ? current.map((c) => (c.id === claim.id ? claim : c))
        : [...current, claim],
    );
  }, []);

  const drop = useCallback((id: string) => {
    setClaims((current) => current.filter((c) => c.id !== id));
  }, []);

  const save = useCallback(
    async (id: string, text: string, expectedRevision: number): Promise<SaveOutcome> => {
      if (inFlight.current.has(id)) return { kind: "error", message: "Still saving. One moment." };
      inFlight.current.add(id);
      const result = await call(`/api/claims/${id}`, "PATCH", { text, expectedRevision });
      inFlight.current.delete(id);

      if (!result) return { kind: "error", message: COPY.network };
      if (result.status === 200 && result.body.claim) {
        upsert(result.body.claim);
        setAnnouncement("Claim saved.");
        return { kind: "saved" };
      }
      if (result.status === 409 && result.body.current) return { kind: "conflict", current: result.body.current };
      if (result.status === 404) return { kind: "gone" };
      return { kind: "error", message: failure(result.status, result.body) };
    },
    [upsert],
  );

  const add = useCallback(
    async (block: CanvasBlockKey, text: string): Promise<AddOutcome> => {
      const guard = `add:${block}`;
      if (inFlight.current.has(guard)) return { kind: "error", message: "Still saving. One moment." };
      inFlight.current.add(guard);
      const result = await call("/api/claims", "POST", { block, text });
      inFlight.current.delete(guard);

      if (!result) return { kind: "error", message: COPY.network };
      if (result.status === 201 && result.body.claim) {
        upsert(result.body.claim);
        setAnnouncement("Claim added.");
        return { kind: "added" };
      }
      return { kind: "error", message: failure(result.status, result.body) };
    },
    [upsert],
  );

  const remove = useCallback(
    async (id: string, expectedRevision: number): Promise<RemoveOutcome> => {
      if (inFlight.current.has(id)) return { kind: "error", message: "Still working. One moment." };
      inFlight.current.add(id);
      const result = await call(`/api/claims/${id}`, "DELETE", { expectedRevision });
      inFlight.current.delete(id);

      if (!result) return { kind: "error", message: COPY.network };
      if (result.status === 200) {
        drop(id);
        setAnnouncement("Claim deleted.");
        return { kind: "removed" };
      }
      if (result.status === 409 && result.body.current) {
        // Show the newer wording before deleting it: replace locally, the founder can delete again.
        upsert(result.body.current);
        return { kind: "conflict", current: result.body.current };
      }
      return { kind: "error", message: failure(result.status, result.body) };
    },
    [drop, upsert],
  );

  return { claims, announcement, save, add, remove, upsert, drop };
}

export type ClaimEditor = ReturnType<typeof useClaimEditor>;
