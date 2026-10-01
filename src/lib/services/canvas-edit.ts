// Pure rules for editing the canvas by hand (S-03): input schemas, the allow-listed shape a claim leaves the server
// in, and the error-code to status mapping. No `astro:*`, no `@/`, relative imports only, so
// scripts/test-canvas-edit.mjs can import it with `--experimental-strip-types`. The writes themselves are in
// ./claims.ts; the revision/origin rules are enforced by the database (canvas_claims_guard).
import { z } from "zod";
import type { CanvasBlockKey, PublicClaim } from "../../types.ts";
import { CANVAS_BLOCKS, CLAIM_MAX_LENGTH } from "./canvas-draft.ts";

/** Claims per block a founder can hold. Mirrors `c_cap` in `add_canvas_claim` (supabase/migrations). */
export const BLOCK_CLAIM_CAP = 12;

const BLOCK_KEYS = CANVAS_BLOCKS.map((block) => block.key) as [CanvasBlockKey, ...CanvasBlockKey[]];

/** One short line: line breaks collapse to spaces, edges are trimmed, the database's 1..280 bound is enforced. */
export const claimTextSchema = z
  .string("Write a claim")
  .transform((value) => value.replace(/\s*[\r\n]+\s*/g, " ").trim())
  .pipe(
    z
      .string()
      .min(1, "Write a claim first")
      .max(CLAIM_MAX_LENGTH, `Keep a claim to ${CLAIM_MAX_LENGTH} characters or fewer`),
  );

const revisionSchema = z.number("Missing revision").int("Invalid revision").positive("Invalid revision");

export const createClaimSchema = z.object({ block: z.enum(BLOCK_KEYS, "Unknown block"), text: claimTextSchema });
export const updateClaimSchema = z.object({ text: claimTextSchema, expectedRevision: revisionSchema });
export const deleteClaimSchema = z.object({ expectedRevision: revisionSchema });

/** Field by field (never a spread of a row) so a future column cannot leak into a response or page props. */
export function toPublicClaim(row: {
  id: string;
  block: CanvasBlockKey;
  position: number;
  text: string;
  origin: "ai_draft" | "founder";
  revision: number;
}): PublicClaim {
  return {
    id: row.id,
    block: row.block,
    position: row.position,
    text: row.text,
    origin: row.origin,
    revision: row.revision,
  };
}

export type ClaimErrorCode = "not_found" | "conflict" | "block_full" | "server_error";

export function statusForClaimCode(code: string): number {
  switch (code) {
    case "not_found":
      return 404;
    case "conflict":
    case "block_full":
      return 409;
    case "invalid":
      return 400;
    default:
      return 500;
  }
}
