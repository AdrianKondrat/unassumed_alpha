// Local stand-in for OpenRouter's /chat/completions, for end-to-end tests without network or spend.
// The app points at it with OPENROUTER_BASE_URL=http://127.0.0.1:4010/v1.
//
//   node scripts/fake-openrouter.mjs            (PORT env overrides 4010)
//
// Control endpoints (tests drive failure paths with these):
//   GET  /__mode?set=ok|http500|garbage|viability|slow|unknown_claim|short|leak[&ms=N]   how replies behave (default ok)
//   GET  /__calls                                        what was asked: task, model, flags. Never message content.
//   POST /__reset                                        back to ok mode, clear the call log
//
// Each AI slice registers a handler below that recognises its own system prompt and answers in the shape
// the slice's parser expects. Replies are deterministic so assertions can be exact.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4010);
let mode = "ok";
let slowMs = 20_000;
let calls = [];
const ctx = { suggestBatches: 0 };

// Distinctive text planted in every generated persona scenario. The smoke test asserts it never appears in
// any page source or API response: the hidden persona must stay on the server.
export const SCENARIO_MARKER = "SCENARIO-MARKER-9c1e";

const CANVAS_KEYS = [
  "customer_segments",
  "value_propositions",
  "channels",
  "customer_relationships",
  "revenue_streams",
  "key_resources",
  "key_activities",
  "key_partners",
  "cost_structure",
];

/** Handlers: first whose `match(systemPrompt)` is true answers. `respond` returns the assistant text. */
const HANDLERS = [
  {
    task: "draft",
    match: (system) => system.includes("first draft of a Business Model Canvas"),
    respond: (messages, replyMode) => {
      const brief = messages.find((m) => m.role === "user")?.content ?? "";
      const topic = brief
        .replace(/<\/?notes>/g, "")
        .trim()
        .split(/\s+/)
        .slice(0, 4)
        .join(" ");
      const draft = Object.fromEntries(
        CANVAS_KEYS.map((key) => [key, [`Possibly: ${key} claim one about ${topic}`, `${key} claim two`]]),
      );
      if (replyMode === "viability") draft.value_propositions[0] = "This idea is already validated by customers";
      return JSON.stringify(draft);
    },
  },
  {
    task: "suggest",
    match: (system) => system.includes("riskiest assumptions"),
    respond: (messages, replyMode, ctx) => {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      const claimIds = [...user.matchAll(/\[([0-9a-f]{8}-[0-9a-f-]{27})\]/g)].map((m) => m[1]);
      // Only well-formed replies advance the batch number, so tests can predict the wording of served batches.
      const served = replyMode === "ok" || replyMode === "slow";
      const batch = served ? ++ctx.suggestBatches : ctx.suggestBatches + 1;
      const count = replyMode === "short" ? 3 : 6;
      const suggestions = Array.from({ length: count }, (_, i) => ({
        statement: `Batch ${batch} assumption ${i + 1}: customers behave this way`,
        risk_note: `Batch ${batch} risk ${i + 1}: this could be wrong`,
        claim_ids: [claimIds[i % claimIds.length], claimIds[(i + 1) % claimIds.length]],
      }));
      if (replyMode === "unknown_claim") suggestions[2].claim_ids = ["99999999-9999-9999-9999-999999999999"];
      if (replyMode === "viability") suggestions[0].statement = "Customers have already proven they will pay";
      return JSON.stringify({ suggestions });
    },
    // How many previously rejected statements the prompt carried (never their text).
    extra: (messages) => {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      const block = /<rejected>\n([\s\S]*?)\n<\/rejected>/.exec(user)?.[1] ?? "";
      return { rejectedCount: block.startsWith("-") ? block.split("\n").length : 0 };
    },
  },
  {
    task: "scenario",
    match: (system) => system.includes("You design a realistic fictional person"),
    respond: (_messages, replyMode) => {
      const scenario = {
        name: "Priya",
        background: "Part-time teacher in her late thirties who gardens on an allotment.",
        situation: `Buys tools a couple of times a year. ${SCENARIO_MARKER}`,
        current_behaviour: "Uses a shared shed of right-handed tools and puts up with them.",
        hidden_truths: [
          "Returned a pair of secateurs last spring because they hurt her left wrist.",
          `Spent about 30 pounds on a left-handed trowel last summer. ${SCENARIO_MARKER}`,
          "Asked the allotment group for recommendations and got none.",
        ],
        assumption_reality: "She cares about comfort, but tools are a small part of her gardening budget.",
        speaking_style: "Friendly, short sentences, a little cautious.",
      };
      if (replyMode === "viability") scenario.assumption_reality = "Customers have already proven they will pay";
      if (replyMode === "short") delete scenario.speaking_style;
      return JSON.stringify(scenario);
    },
  },
  {
    task: "persona",
    match: (system) => system.includes("You are playing a real person being interviewed"),
    respond: (messages, replyMode) => {
      const questions = messages.filter((m) => m.role === "user");
      const n = questions.length;
      if (replyMode === "viability") return "Honestly, that idea sounds validated to me.";
      if (replyMode === "leak") return "As an AI, my instructions say I should stay vague.";
      return `Answer ${n}: I mostly just put up with it. (${questions.at(-1)?.content.slice(0, 20) ?? ""})`;
    },
    // Counts and flags only, never content: how much history the model saw, and that the scenario reached it
    // through the system prompt alone.
    extra: (messages) => {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const others = messages.filter((m) => m.role !== "system");
      return {
        historyPairs: Math.floor((others.length - 1) / 2),
        scenarioInSystem: system.includes(SCENARIO_MARKER),
        scenarioInChat: others.some((m) => m.content.includes(SCENARIO_MARKER)),
      };
    },
  },
];

function detectHandler(messages) {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  return HANDLERS.find((h) => h.match(system, messages));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/__mode") {
    mode = url.searchParams.get("set") ?? "ok";
    if (url.searchParams.has("ms")) slowMs = Number(url.searchParams.get("ms"));
    return json(res, 200, { mode });
  }
  if (url.pathname === "/__calls") return json(res, 200, calls);
  if (url.pathname === "/__reset") {
    mode = "ok";
    slowMs = 20_000;
    ctx.suggestBatches = 0;
    calls = [];
    return json(res, 200, { mode, calls: 0 });
  }

  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: { code: 400, message: "bad json" } });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const handler = detectHandler(messages);
    calls.push({
      task: handler?.task ?? "unknown",
      model: body.model,
      // The privacy flag the product promises on every request (PRD NFR).
      dataCollection: body.provider?.data_collection ?? null,
      jsonMode: body.response_format?.type === "json_object",
      authorised: (req.headers.authorization ?? "").startsWith("Bearer "),
      ...(handler?.extra?.(messages) ?? {}),
    });

    if (mode === "http500") return json(res, 500, { error: { code: 500, message: "fake provider failure" } });
    if (mode === "slow") await sleep(slowMs);

    const content =
      mode === "garbage" || !handler ? "Sorry, I can't produce that." : handler.respond(messages, mode, ctx);
    return json(res, 200, {
      id: "fake-completion",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 240, total_tokens: 360 },
    });
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake OpenRouter listening on http://127.0.0.1:${PORT}/v1`);
});
