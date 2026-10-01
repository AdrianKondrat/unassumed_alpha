// Local stand-in for OpenRouter's /chat/completions, for end-to-end tests without network or spend.
// The app points at it with OPENROUTER_BASE_URL=http://127.0.0.1:4010/v1.
//
//   node scripts/fake-openrouter.mjs            (PORT env overrides 4010)
//
// Control endpoints (tests drive failure paths with these):
//   GET  /__mode?set=ok|http500|garbage|viability|slow[&ms=N]   choose how replies behave (default ok)
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
    match: (system) => system.includes("Business Model Canvas"),
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
    });

    if (mode === "http500") return json(res, 500, { error: { code: 500, message: "fake provider failure" } });
    if (mode === "slow") await sleep(slowMs);

    const content = mode === "garbage" || !handler ? "Sorry, I can't produce that." : handler.respond(messages, mode);
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
