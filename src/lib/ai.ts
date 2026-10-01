// Server-only AI entry point. Every AI-touching slice (canvas draft, assumption suggestion, rehearsal
// persona, scoring) calls `complete()`; it is the only place the OpenRouter key is read and the only
// path that sets the zero-data-retention routing flag and records usage.
//
// Never import this from a React island or an Astro page's client script.
import type { SupabaseClient } from "@supabase/supabase-js";
import { OPENROUTER_API_KEY, OPENROUTER_BASE_URL } from "astro:env/server";
import { buildUsageRow, callOpenRouter } from "./ai-request.ts";
import type { AIMessage, AIResult, AITaskKind } from "./ai-request.ts";

export type { AIMessage, AIResult, AITaskKind, AIUsage } from "./ai-request.ts";

export interface CompleteParams {
  taskKind: AITaskKind;
  messages: AIMessage[];
  /** The calling founder's request-scoped client: the usage row is inserted under their RLS. */
  supabase: SupabaseClient;
  founderId: string;
  overrideModel?: string;
  /** Per-attempt timeout override (defaults to the task's configured timeout). */
  timeoutMs?: number;
  /** Set false to disable the built-in single retry, e.g. when the caller owns an overall deadline. */
  retry?: boolean;
  /** Ask for a JSON object response. The prompt must also instruct the model to answer in JSON. */
  jsonMode?: boolean;
}

export async function complete(params: CompleteParams): Promise<AIResult> {
  if (!OPENROUTER_API_KEY) {
    return { ok: false, error: { kind: "provider_error", message: "OpenRouter is not configured" } };
  }

  const result = await callOpenRouter({
    apiKey: OPENROUTER_API_KEY,
    baseUrl: OPENROUTER_BASE_URL,
    taskKind: params.taskKind,
    messages: params.messages,
    overrideModel: params.overrideModel,
    timeoutMs: params.timeoutMs,
    retry: params.retry,
    jsonMode: params.jsonMode,
  });

  if (result.ok) {
    // Usage telemetry is non-critical: the founder already has their answer, so a failed insert is
    // logged (code only, never content) and does not fail the call.
    const { error } = await params.supabase.from("ai_usage_events").insert(
      buildUsageRow({
        founderId: params.founderId,
        taskKind: params.taskKind,
        model: result.model,
        usage: result.usage,
      }),
    );
    if (error) {
      // eslint-disable-next-line no-console
      console.error("ai_usage_events insert failed", error.code);
    }
  }

  return result;
}
