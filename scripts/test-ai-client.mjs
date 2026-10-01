// Offline checks for the AI call path (F-02). No network, no dependencies.
// Run: npm run test:ai   (imports the pure module via node --experimental-strip-types)
import {
  TASK_CONFIG,
  OPENROUTER_URL,
  buildOpenRouterRequest,
  buildUsageRow,
  callOpenRouter,
} from "../src/lib/ai-request.ts";

const KINDS = ["draft", "suggest", "converse", "score"];
const messages = [{ role: "user", content: "hello" }];
const noSleep = () => Promise.resolve();

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const okBody = (content = "hi") => ({
  model: "openai/gpt-4o-mini-2024",
  choices: [{ message: { role: "assistant", content } }],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
});

/** Fake fetch that serves queued responses/errors and records calls. */
function fakeFetch(queue) {
  const calls = [];
  const impl = (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error("fakeFetch queue exhausted");
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  return { impl, calls };
}
const timeoutError = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });
const call = async (queue, extra = {}) => {
  const f = fakeFetch(queue);
  const result = await callOpenRouter({
    apiKey: "sk-test-secret",
    taskKind: "draft",
    messages,
    fetchImpl: f.impl,
    sleepImpl: noSleep,
    ...extra,
  });
  return { result, calls: f.calls };
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const steps = [];
const step = (name, fn) => steps.push([name, fn]);

for (const kind of KINDS) {
  step(`request for "${kind}" always carries the zero-data-retention flag`, () => {
    const body = buildOpenRouterRequest(kind, messages);
    assert(body.provider.data_collection === "deny", "provider.data_collection must be 'deny'");
  });
  step(`request for "${kind}" resolves its configured model`, () => {
    assert(buildOpenRouterRequest(kind, messages).model === TASK_CONFIG[kind].model, "wrong default model");
  });
}
step("overrideModel wins over the task default", () => {
  assert(buildOpenRouterRequest("draft", messages, "foo/bar").model === "foo/bar", "override ignored");
});
step("override does not remove the privacy flag", () => {
  assert(buildOpenRouterRequest("score", messages, "foo/bar").provider.data_collection === "deny", "flag lost");
});
step("jsonMode adds response_format only when requested", () => {
  assert(buildOpenRouterRequest("draft", messages).response_format === undefined, "unexpected response_format");
  assert(
    buildOpenRouterRequest("draft", messages, undefined, { jsonMode: true }).response_format?.type === "json_object",
    "response_format missing",
  );
});
step("score timeout leaves room for one retry inside 60s", () => {
  assert(TASK_CONFIG.score.timeoutMs <= 25_000 && TASK_CONFIG.converse.timeoutMs <= 10_000, "timeouts grew");
});

step("usage row maps tokens and founder", () => {
  const row = buildUsageRow({
    founderId: "f1",
    taskKind: "suggest",
    model: "m",
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  });
  assert(
    row.founder_id === "f1" &&
      row.task_kind === "suggest" &&
      row.prompt_tokens === 1 &&
      row.completion_tokens === 2 &&
      row.total_tokens === 3,
    "bad usage row",
  );
});

step("success returns text, usage and the provider-reported model", async () => {
  const { result } = await call([jsonResponse(okBody("answer"))]);
  assert(result.ok && result.text === "answer", "no text");
  assert(result.usage.totalTokens === 12 && result.usage.promptTokens === 5, "usage wrong");
  assert(result.model === "openai/gpt-4o-mini-2024", "model wrong");
});
step("the wire request is a POST to OpenRouter with bearer auth and the privacy flag", async () => {
  const { calls } = await call([jsonResponse(okBody())]);
  const { url, init } = calls[0];
  assert(url === OPENROUTER_URL && init.method === "POST", "wrong url/method");
  assert(init.headers.Authorization === "Bearer sk-test-secret", "missing bearer auth");
  assert(JSON.parse(init.body).provider.data_collection === "deny", "flag missing on the wire");
  assert(init.signal instanceof AbortSignal, "no timeout signal");
});
step("baseUrl overrides the endpoint, trailing slash tolerated", async () => {
  const { calls } = await call([jsonResponse(okBody())], { baseUrl: "http://127.0.0.1:9/v1/" });
  assert(calls[0].url === "http://127.0.0.1:9/v1/chat/completions", `got ${calls[0].url}`);
});
step("total tokens fall back to prompt + completion", async () => {
  const body = okBody();
  delete body.usage.total_tokens;
  const { result } = await call([jsonResponse(body)]);
  assert(result.ok && result.usage.totalTokens === 12, "fallback wrong");
});
step("a 500 is retried once and then succeeds", async () => {
  const { result, calls } = await call([jsonResponse({}, 500), jsonResponse(okBody())]);
  assert(result.ok && calls.length === 2, "expected 2 calls and success");
});
step("a 429 twice yields rate_limited after exactly 2 calls", async () => {
  const { result, calls } = await call([jsonResponse({}, 429), jsonResponse({}, 429)]);
  assert(!result.ok && result.error.kind === "rate_limited" && calls.length === 2, "wrong outcome");
});
step("a timeout twice yields timeout after exactly 2 calls", async () => {
  const { result, calls } = await call([timeoutError(), timeoutError()]);
  assert(!result.ok && result.error.kind === "timeout" && calls.length === 2, "wrong outcome");
});
step("network failure is a retryable provider_error", async () => {
  const { result, calls } = await call([new TypeError("fetch failed"), jsonResponse(okBody())]);
  assert(result.ok && calls.length === 2, "should have recovered on retry");
});
step("retry:false makes a single attempt", async () => {
  const { result, calls } = await call([jsonResponse({}, 500), jsonResponse(okBody())], { retry: false });
  assert(!result.ok && result.error.kind === "provider_error" && calls.length === 1, "retried despite retry:false");
});
step("a 401 is not retried", async () => {
  const { result, calls } = await call([jsonResponse({}, 401), jsonResponse(okBody())]);
  assert(!result.ok && result.error.kind === "provider_error" && calls.length === 1, "retried a 401");
});
step("200 with an error envelope maps to a typed failure", async () => {
  const { result } = await call([
    jsonResponse({ error: { code: 429, message: "slow down" } }),
    jsonResponse({ error: { code: 429 } }),
  ]);
  assert(!result.ok && result.error.kind === "rate_limited", "envelope not mapped");
});
step("missing or empty content is invalid_response and not retried", async () => {
  for (const body of [{ choices: [] }, { choices: [{ message: { content: "  " } }] }, { nope: 1 }]) {
    const { result, calls } = await call([jsonResponse(body), jsonResponse(okBody())]);
    assert(!result.ok && result.error.kind === "invalid_response" && calls.length === 1, "bad handling");
  }
});
step("non-JSON body is invalid_response", async () => {
  const { result } = await call([new Response("<html>", { status: 200 })]);
  assert(!result.ok && result.error.kind === "invalid_response", "wrong kind");
});
step("error messages never leak the API key or prompt text", async () => {
  const secretMessages = [{ role: "user", content: "TOP-SECRET-FOUNDER-IDEA" }];
  for (const queue of [
    [jsonResponse({}, 500), jsonResponse({}, 500)],
    [timeoutError(), timeoutError()],
  ]) {
    const { result } = await call(queue, { messages: secretMessages });
    const text = JSON.stringify(result);
    assert(!text.includes("sk-test-secret") && !text.includes("TOP-SECRET-FOUNDER-IDEA"), "leak in error");
  }
});
step("a retry sleeps with the configured backoff", async () => {
  const slept = [];
  await call([jsonResponse({}, 503), jsonResponse(okBody())], {
    sleepImpl: (ms) => (slept.push(ms), Promise.resolve()),
  });
  assert(slept.length === 1 && slept[0] === 500, "expected one 500ms backoff");
});

let failed = 0;
for (const [name, fn] of steps) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(failed ? `\n${failed} step(s) failed` : `\nAll ${steps.length} AI client checks passed`);
process.exit(failed ? 1 : 0);
