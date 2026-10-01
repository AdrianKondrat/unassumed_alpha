import type { SupabaseClient } from "@supabase/supabase-js";
import type { Assumption, CanvasBlockKey, DurableAssumptionStatus } from "@/types";
import { computeReviewUpdate } from "./assumption-suggest";
import type { ReviewInput } from "./assumption-suggest";

const COLUMNS = "id, project_id, statement, risk_note, status, origin, edited, created_at, updated_at";

/** A claim an assumption was derived from, as shown on its review card. */
export interface SourceClaim {
  id: string;
  block: CanvasBlockKey;
  text: string;
}

export interface AssumptionWithSources extends Assumption {
  sources: SourceClaim[];
}

interface LinkRow {
  assumption_id: string;
  canvas_claims: SourceClaim | null;
}

/**
 * Pending suggestions (oldest first, so the AI's riskiest-first order is kept) and the accepted list
 * (newest first), each with their source claims. Rejected rows are not returned.
 */
export async function listAssumptions(
  supabase: SupabaseClient,
  projectId: string,
): Promise<{ pending: AssumptionWithSources[]; durable: AssumptionWithSources[] }> {
  const { data, error } = await supabase
    .from("assumptions")
    .select(COLUMNS)
    .eq("project_id", projectId)
    .in("status", ["suggested", "active", "superseded", "retired"])
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .overrideTypes<Assumption[], { merge: false }>();
  if (error) {
    // eslint-disable-next-line no-console
    console.error("listAssumptions failed", error.code);
    return { pending: [], durable: [] };
  }

  const sourcesById = new Map<string, SourceClaim[]>();
  if (data.length > 0) {
    const links = await supabase
      .from("assumption_claims")
      .select("assumption_id, canvas_claims(id, block, text)")
      .in(
        "assumption_id",
        data.map((row) => row.id),
      )
      .overrideTypes<LinkRow[], { merge: false }>();
    if (links.error) {
      // eslint-disable-next-line no-console
      console.error("listAssumptions links failed", links.error.code);
    } else {
      for (const link of links.data) {
        if (!link.canvas_claims) continue;
        sourcesById.set(link.assumption_id, [...(sourcesById.get(link.assumption_id) ?? []), link.canvas_claims]);
      }
    }
  }

  const rows = data.map((row) => ({ ...row, sources: sourcesById.get(row.id) ?? [] }));
  return {
    pending: rows.filter((row) => row.status === "suggested"),
    durable: rows.filter((row) => row.status !== "suggested").reverse(),
  };
}

export type MutationResult = { ok: true } | { ok: false; code: "not_pending" | "not_durable" | "failed" };

/**
 * Applies the founder's accept / edit-accept / reject decision. The update is conditional on the row still
 * being `suggested`, so a second tab or a replayed request affects zero rows and reports `not_pending`.
 */
export async function reviewAssumption(
  supabase: SupabaseClient,
  id: string,
  input: ReviewInput,
): Promise<MutationResult> {
  const { data: current, error: loadError } = await supabase
    .from("assumptions")
    .select("statement, risk_note, status")
    .eq("id", id)
    .maybeSingle<{ statement: string; risk_note: string | null; status: string }>();
  if (loadError) return { ok: false, code: "failed" };
  if (current?.status !== "suggested") return { ok: false, code: "not_pending" };

  const { data, error } = await supabase
    .from("assumptions")
    .update(computeReviewUpdate(current, input))
    .eq("id", id)
    .eq("status", "suggested")
    .select("id");
  if (error) {
    // eslint-disable-next-line no-console
    console.error("reviewAssumption failed", error.code);
    return { ok: false, code: "failed" };
  }
  return data.length > 0 ? { ok: true } : { ok: false, code: "not_pending" };
}

/** Sets the lifecycle status of an accepted assumption. Pending and rejected rows can never be moved here. */
export async function setAssumptionStatus(
  supabase: SupabaseClient,
  id: string,
  status: DurableAssumptionStatus,
): Promise<MutationResult> {
  const { data, error } = await supabase
    .from("assumptions")
    .update({ status })
    .eq("id", id)
    .in("status", ["active", "superseded", "retired"])
    .select("id");
  if (error) {
    // eslint-disable-next-line no-console
    console.error("setAssumptionStatus failed", error.code);
    return { ok: false, code: "failed" };
  }
  return data.length > 0 ? { ok: true } : { ok: false, code: "not_durable" };
}
