// Pure core of the AI call path: task config, request builder, and the OpenRouter call with timeout/retry.
// Dependency-free on purpose (no `astro:*`, no `@/`, relative imports only) so plain Node can import it
// with `--experimental-strip-types` for scripts/test-ai-client.mjs. The Astro-facing wrapper is ./ai.ts.
//
// Privacy: prompts and responses are founder content. Nothing in this module logs them, and error
// messages never include request or response bodies.

export type AITaskKind = "draft" | "suggest" | "converse" | "score";

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type AIErrorKind = "timeout" | "rate_limited" | "provider_error" | "invalid_response";

export type AIResult =
  | { ok: true; text: string; usage: AIUsage; model: string }
  | { ok: false; error: { kind: AIErrorKind; message: string } };

export interface TaskConfig {
  model: string;
  timeoutMs: number;
}

// One shared default model for now; each entry can be swapped independently without touching call sites.
// Confirm current availability/pricing of the slug on OpenRouter before launch.
export const TASK_CONFIG: Record<AITaskKind, TaskConfig> = {
  draft: { model: "openai/gpt-4o-mini", timeoutMs: 15_000 },
  suggest: { model: "openai/gpt-4o-mini", timeoutMs: 15_000 },
  converse: { model: "openai/gpt-4o-mini", timeoutMs: 10_000 },
  score: { model: "openai/gpt-4o-mini", timeoutMs: 25_000 },
};

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_URL = `${OPENROUTER_BASE_URL}/chat/completions`;
export const RETRY_BACKOFF_MS = 500;

export interface OpenRouterRequestBody {
  model: string;
  messages: AIMessage[];
  // Restricts routing to providers that do not retain or train on prompts (PRD privacy NFR).
  provider: { data_collection: "deny" };
  response_format?: { type: "json_object" };
}

/**
 * Builds the request body. The privacy opt-out lives here (not at call sites) so it is impossible to
 * forget and trivially testable.
 */
export function buildOpenRouterRequest(
  taskKind: AITaskKind,
  messages: AIMessage[],
  overrideModel?: string,
  options: { jsonMode?: boolean } = {},
): OpenRouterRequestBody {
  const body: OpenRouterRequestBody = {
    model: overrideModel ?? TASK_CONFIG[taskKind].model,
    messages,
    provider: { data_collection: "deny" },
  };
  if (options.jsonMode) {
    body.response_format = { type: "json_object" };
  }
  return body;
}

export interface UsageEventRow {
  founder_id: string;
  task_kind: AITaskKind;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export function buildUsageRow(params: {
  founderId: string;
  taskKind: AITaskKind;
  model: string;
  usage: AIUsage;
}): UsageEventRow {
  return {
    founder_id: params.founderId,
    task_kind: params.taskKind,
    model: params.model,
    prompt_tokens: params.usage.promptTokens,
    completion_tokens: params.usage.completionTokens,
    total_tokens: params.usage.totalTokens,
  };
}

export interface CallOpenRouterParams {
  apiKey: string;
  /** Override for the API base URL (local fakes in tests). Defaults to OpenRouter. */
  baseUrl?: string;
  taskKind: AITaskKind;
  messages: AIMessage[];
  overrideModel?: string;
  /** Per-attempt timeout. Defaults to the task's configured timeout. */
  timeoutMs?: number;
  /** Retry once after a short backoff on timeout / 429 / 5xx / network error. Default true. */
  retry?: boolean;
  /** Ask the provider for a JSON object response (prompt must also say "JSON"). */
  jsonMode?: boolean;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

interface Attempt {
  result: AIResult;
  retryable: boolean;
}

function failure(kind: AIErrorKind, message: string, retryable: boolean): Attempt {
  return { result: { ok: false, error: { kind, message } }, retryable };
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function classifyStatus(status: number): Attempt {
  if (status === 429) return failure("rate_limited", "The AI provider is rate limiting requests (429)", true);
  if (status >= 500) return failure("provider_error", `The AI provider returned an error (${status})`, true);
  return failure("provider_error", `The AI provider rejected the request (${status})`, false);
}

function parseSuccess(body: unknown, requestedModel: string): Attempt {
  if (!isRecord(body)) return failure("invalid_response", "The AI provider returned an unreadable response", false);

  // OpenRouter can answer 200 with an error envelope.
  if (isRecord(body.error)) {
    const code = typeof body.error.code === "number" ? body.error.code : 0;
    return code ? classifyStatus(code) : failure("provider_error", "The AI provider reported an error", false);
  }

  const choices = body.choices;
  const first: unknown = Array.isArray(choices) ? (choices as unknown[])[0] : undefined;
  const message = isRecord(first) ? first.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content !== "string" || content.trim() === "") {
    return failure("invalid_response", "The AI provider returned an empty response", false);
  }

  const usage = isRecord(body.usage) ? body.usage : {};
  const promptTokens = toCount(usage.prompt_tokens);
  const completionTokens = toCount(usage.completion_tokens);
  const totalTokens = toCount(usage.total_tokens) || promptTokens + completionTokens;
  const model = typeof body.model === "string" && body.model ? body.model : requestedModel;

  return {
    result: { ok: true, text: content, usage: { promptTokens, completionTokens, totalTokens }, model },
    retryable: false,
  };
}

async function attemptOnce(params: CallOpenRouterParams, fetchImpl: typeof fetch): Promise<Attempt> {
  const requestBody = buildOpenRouterRequest(params.taskKind, params.messages, params.overrideModel, {
    jsonMode: params.jsonMode,
  });
  const timeoutMs = params.timeoutMs ?? TASK_CONFIG[params.taskKind].timeoutMs;

  let response: Response;
  try {
    response = await fetchImpl(`${(params.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Unassumed",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return failure("timeout", "The AI provider took too long to respond", true);
    }
    return failure("provider_error", "Could not reach the AI provider", true);
  }

  if (!response.ok) return classifyStatus(response.status);

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return failure("timeout", "The AI provider took too long to respond", true);
    }
    return failure("invalid_response", "The AI provider returned an unreadable response", false);
  }
  return parseSuccess(body, requestBody.model);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls OpenRouter with a per-attempt timeout and (by default) one retry. Never throws. */
export async function callOpenRouter(params: CallOpenRouterParams): Promise<AIResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const sleep = params.sleepImpl ?? defaultSleep;
  const maxAttempts = params.retry === false ? 1 : 2;

  let last: Attempt = failure("provider_error", "The AI request was not attempted", false);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await attemptOnce(params, fetchImpl);
    if (last.result.ok || !last.retryable) return last.result;
    if (attempt < maxAttempts) await sleep(RETRY_BACKOFF_MS);
  }
  return last.result;
}
