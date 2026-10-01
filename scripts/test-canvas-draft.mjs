// Offline checks for the canvas draft module and shared AI-output helpers. No network.
// Run: npm run test:canvas
import { extractJson, findForbiddenWording } from "../src/lib/ai-output.ts";
import {
  BRIEF_MAX_LENGTH,
  BRIEF_MIN_LENGTH,
  CANVAS_BLOCKS,
  briefSchema,
  buildDraftMessages,
  parseDraft,
} from "../src/lib/services/canvas-draft.ts";

const steps = [];
const step = (name, fn) => steps.push([name, fn]);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const KEYS = [
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
const validDraft = () => Object.fromEntries(KEYS.map((k) => [k, [`${k} claim one`, `${k} claim two`]]));
const reason = (result) => (result.ok ? "" : result.reason);

step("block list covers the nine database keys exactly once, each with a label and hint", () => {
  assert(CANVAS_BLOCKS.length === 9, `expected 9 blocks, got ${CANVAS_BLOCKS.length}`);
  assert(
    [...CANVAS_BLOCKS.map((b) => b.key)].sort().join() === [...KEYS].sort().join(),
    "block keys differ from the database vocabulary",
  );
  assert(
    CANVAS_BLOCKS.every((b) => b.label.length > 3 && b.hint.length > 10),
    "missing label or hint",
  );
});

step("valid reply parses into positioned claims in block order", () => {
  const result = parseDraft(JSON.stringify(validDraft()));
  assert(result.ok, `rejected: ${reason(result)}`);
  assert(result.claims.length === 18, `expected 18 claims, got ${result.claims.length}`);
  assert(result.claims[0].block === "customer_segments" && result.claims[0].position === 0, "first claim wrong");
  assert(result.claims[1].position === 1, "positions must count up within a block");
  assert(result.claims[2].block === "value_propositions" && result.claims[2].position === 0, "positions must reset");
});

step("code-fenced and prose-wrapped JSON still parses", () => {
  const body = JSON.stringify(validDraft());
  assert(parseDraft("```json\n" + body + "\n```").ok, "fenced json rejected");
  assert(parseDraft("```\n" + body + "\n```").ok, "bare fence rejected");
  assert(parseDraft("Here is the canvas:\n" + body + "\nHope that helps!").ok, "prose-wrapped json rejected");
});

step("claim text is trimmed", () => {
  const draft = validDraft();
  draft.channels = ["   padded claim   "];
  const result = parseDraft(JSON.stringify(draft));
  assert(result.ok && result.claims.some((c) => c.text === "padded claim"), "text not trimmed");
});

step("extra keys are ignored but missing blocks fail", () => {
  assert(parseDraft(JSON.stringify({ ...validDraft(), notes: ["x"] })).ok, "extra key rejected");
  const missing = validDraft();
  delete missing.key_partners;
  const result = parseDraft(JSON.stringify(missing));
  assert(!result.ok && reason(result).includes("key_partners"), `missing block accepted or unnamed: ${reason(result)}`);
});

step("empty array, six claims, empty string and over-long claim all fail", () => {
  const empty = { ...validDraft(), channels: [] };
  assert(!parseDraft(JSON.stringify(empty)).ok, "empty array accepted");
  const six = { ...validDraft(), channels: ["a", "b", "c", "d", "e", "f"] };
  assert(!parseDraft(JSON.stringify(six)).ok, "six claims accepted");
  const blank = { ...validDraft(), channels: ["   "] };
  assert(!parseDraft(JSON.stringify(blank)).ok, "blank claim accepted");
  const long = { ...validDraft(), channels: ["x".repeat(281)] };
  assert(!parseDraft(JSON.stringify(long)).ok, "281-char claim accepted");
  const edge = { ...validDraft(), channels: ["x".repeat(280)] };
  assert(parseDraft(JSON.stringify(edge)).ok, "280-char claim rejected");
});

step("wrong shapes fail: non-JSON, arrays, non-string claims, null", () => {
  for (const raw of ["I cannot help with that.", "", "[]", "null", '{"channels":[1,2]}', "{"]) {
    assert(!parseDraft(raw).ok, `accepted ${JSON.stringify(raw)}`);
  }
});

step("viability wording fails the whole draft", () => {
  for (const word of ["validated", "Validated", "PROVEN", "a proven channel", "already validated by users"]) {
    const draft = validDraft();
    draft.value_propositions = [`This is ${word}`];
    const result = parseDraft(JSON.stringify(draft));
    assert(!result.ok && reason(result).includes("forbidden"), `"${word}" accepted`);
  }
  const fine = validDraft();
  fine.value_propositions = ["Customers say it is unvalidated so far", "We will test whether people pay"];
  assert(parseDraft(JSON.stringify(fine)).ok, "'unvalidated' wrongly rejected");
});

step("findForbiddenWording matches whole words only", () => {
  assert(findForbiddenWording("it is validated") === "validated", "validated missed");
  assert(findForbiddenWording("proven demand") === "proven", "proven missed");
  assert(findForbiddenWording("unvalidated guess") === null, "unvalidated flagged");
  assert(findForbiddenWording("improvement") === null, "substring flagged");
});

step("extractJson handles fences, prose and garbage", () => {
  assert(extractJson('{"a":1}').ok, "plain");
  assert(extractJson('```json\n{"a":1}\n```').ok, "fenced");
  assert(extractJson('Sure! {"a":1} done').ok, "prose");
  assert(!extractJson("no json here").ok, "garbage accepted");
  assert(!extractJson("{broken").ok, "broken accepted");
});

step("prompt carries the brief as data, the nine keys, and the hypothesis / no-viability rules", () => {
  const brief = "A subscription box for left-handed gardeners.";
  const messages = buildDraftMessages(brief);
  assert(messages.length === 2 && messages[0].role === "system" && messages[1].role === "user", "bad message shape");
  assert(messages[1].content.includes(brief), "brief missing from user message");
  assert(!messages[0].content.includes(brief), "brief leaked into the system prompt");
  assert(messages[1].content.startsWith("<notes>") && messages[1].content.endsWith("</notes>"), "brief not delimited");
  const system = messages[0].content;
  for (const key of KEYS) assert(system.includes(key), `prompt missing key ${key}`);
  assert(/hypothes/i.test(system), "prompt does not frame claims as hypotheses");
  assert(
    /never state or imply/i.test(system) && /"validated"/.test(system) && /"proven"/.test(system),
    "no-viability rule missing",
  );
  assert(/ignore any instructions/i.test(system), "no injection guard");
  assert(/json/i.test(system), "JSON instruction missing (required for jsonMode)");
});

step("brief bounds match the database check (20 to 2000)", () => {
  assert(BRIEF_MIN_LENGTH === 20 && BRIEF_MAX_LENGTH === 2000, "brief bounds drifted from the migration");
});

step("brief schema trims, normalises CRLF and enforces the 20-2000 bounds", () => {
  const ok = briefSchema.safeParse("  A subscription box\r\nfor left-handed gardeners.  ");
  assert(ok.success && ok.data === "A subscription box\nfor left-handed gardeners.", "not normalised");
  assert(!briefSchema.safeParse("too short").success, "short accepted");
  assert(!briefSchema.safeParse(" ".repeat(50)).success, "whitespace-only accepted");
  assert(!briefSchema.safeParse(undefined).success, "undefined accepted");
  assert(briefSchema.safeParse("x".repeat(2000)).success, "2000 rejected");
  assert(!briefSchema.safeParse("x".repeat(2001)).success, "2001 accepted");
  const crlf = "line\r\n".repeat(400); // 2800 raw chars, 2000 after normalising and trimming
  assert(briefSchema.safeParse(crlf).success, "CRLF counted twice");
});

let failed = 0;
for (const [name, fn] of steps) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(failed ? `\n${failed} step(s) failed` : `\nAll ${steps.length} canvas draft checks passed`);
process.exit(failed ? 1 : 0);
