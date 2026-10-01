// Offline checks for src/lib/services/assumption-suggest.ts (prompt, parser, transition rules, review logic).
// No network. Run: npm run test:assumptions
import {
  LIFECYCLE_STATUSES,
  MAX_REJECTED_IN_PROMPT,
  buildSuggestMessages,
  canReview,
  canSetLifecycle,
  computeReviewUpdate,
  lifecycleInputSchema,
  parseSuggestions,
  reviewInputSchema,
} from "../src/lib/services/assumption-suggest.ts";

const steps = [];
const step = (name, fn) => steps.push([name, fn]);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const IDS = [
  "11111111-1111-1111-1111-111111111111",
  "22222222-2222-2222-2222-222222222222",
  "33333333-3333-3333-3333-333333333333",
];
const VALID = new Set(IDS);
const suggestion = (n, extra = {}) => ({
  statement: `Assumption ${n}`,
  risk_note: `Risk ${n}`,
  claim_ids: [IDS[n % 3]],
  ...extra,
});
const batch = (count = 6) => ({ suggestions: Array.from({ length: count }, (_, i) => suggestion(i)) });
const parse = (value) => parseSuggestions(typeof value === "string" ? value : JSON.stringify(value), VALID);
const reason = (result) => (result.ok ? "" : result.reason);

step("a valid batch parses with camelCase fields and claim links", () => {
  const result = parse(batch(6));
  assert(result.ok, `rejected: ${reason(result)}`);
  assert(result.suggestions.length === 6, "wrong count");
  assert(result.suggestions[0].riskNote === "Risk 0" && result.suggestions[0].claimIds[0] === IDS[0], "mapping wrong");
});

step("5 and 8 suggestions are accepted; 4 and 9 are not", () => {
  assert(parse(batch(5)).ok, "5 rejected");
  assert(parse(batch(8)).ok, "8 rejected");
  assert(!parse(batch(4)).ok, "4 accepted");
  assert(!parse(batch(9)).ok, "9 accepted");
  assert(!parse({ suggestions: [] }).ok, "empty accepted");
});

step("fenced and prose-wrapped JSON parses", () => {
  const body = JSON.stringify(batch(5));
  assert(parse("```json\n" + body + "\n```").ok, "fenced rejected");
  assert(parse("Here you go:\n" + body).ok, "prose-wrapped rejected");
});

step("text bounds: empty, whitespace-only and over-long fields fail; 280 is fine", () => {
  for (const bad of [
    { statement: "" },
    { statement: "   " },
    { statement: "x".repeat(281) },
    { risk_note: "" },
    { risk_note: "x".repeat(281) },
  ]) {
    const b = batch(5);
    b.suggestions[2] = suggestion(2, bad);
    assert(!parse(b).ok, `accepted ${JSON.stringify(bad).slice(0, 40)}`);
  }
  const edge = batch(5);
  edge.suggestions[0] = suggestion(0, { statement: "x".repeat(280), risk_note: "y".repeat(280) });
  assert(parse(edge).ok, "280-char fields rejected");
});

step("claim_ids: none, more than 3 and non-string fail; duplicates collapse", () => {
  for (const ids of [[], [...IDS, IDS[0] + "x"], [1, 2]]) {
    const b = batch(5);
    b.suggestions[1] = suggestion(1, { claim_ids: ids });
    assert(!parse(b).ok, `accepted claim_ids ${JSON.stringify(ids)}`);
  }
  const dup = batch(5);
  dup.suggestions[0] = suggestion(0, { claim_ids: [IDS[0], IDS[0], IDS[1]] });
  const result = parse(dup);
  assert(result.ok && result.suggestions[0].claimIds.length === 2, "duplicates not collapsed");
});

step("a claim id the model was never given fails the whole batch", () => {
  const b = batch(6);
  b.suggestions[3] = suggestion(3, { claim_ids: [IDS[0], "99999999-9999-9999-9999-999999999999"] });
  const result = parse(b);
  assert(!result.ok && reason(result).includes("unknown claim"), `got: ${reason(result)}`);
});

step("viability wording in statement or risk note fails; 'unvalidated' is fine", () => {
  for (const field of ["statement", "risk_note"]) {
    for (const word of ["already validated", "Proven demand", "VALIDATED"]) {
      const b = batch(5);
      b.suggestions[4] = suggestion(4, { [field]: word });
      const result = parse(b);
      assert(!result.ok && reason(result).includes("forbidden"), `${field}: "${word}" accepted`);
    }
  }
  const fine = batch(5);
  fine.suggestions[0] = suggestion(0, { statement: "Customers have not tested this: it is unvalidated" });
  assert(parse(fine).ok, "'unvalidated' wrongly rejected");
});

step("wrong shapes fail: non-JSON, bare array, wrong key, null", () => {
  for (const raw of [
    "no json",
    "",
    "[]",
    "null",
    JSON.stringify([suggestion(1)]),
    JSON.stringify({ items: batch(5).suggestions }),
  ]) {
    assert(!parse(raw).ok, `accepted ${JSON.stringify(raw).slice(0, 40)}`);
  }
});

step("prompt carries claim ids, text and labels, the rejected list, and the honesty rules", () => {
  const messages = buildSuggestMessages({
    claims: [
      { id: IDS[0], block: "customer_segments", text: "Left-handed gardeners" },
      { id: IDS[1], block: "revenue_streams", text: "Monthly subscription" },
    ],
    rejectedStatements: ["People like boxes"],
  });
  assert(messages.length === 2 && messages[0].role === "system" && messages[1].role === "user", "bad shape");
  const user = messages[1].content;
  assert(
    user.includes(IDS[0]) && user.includes("Left-handed gardeners") && user.includes("Customer segments"),
    "claim 1 missing",
  );
  assert(user.includes(IDS[1]) && user.includes("Revenue streams"), "claim 2 missing");
  assert(user.includes("People like boxes"), "rejected statement missing");
  const system = messages[0].content;
  assert(/risky guesses/i.test(system) && /never facts/i.test(system), "hypothesis framing missing");
  assert(
    /never state or imply/i.test(system) && /"validated"/.test(system) && /"proven"/.test(system),
    "no-viability rule missing",
  );
  assert(/ignore any instructions/i.test(system), "no injection guard");
  assert(/near-duplicate/i.test(system), "no repeat-avoidance rule");
  assert(/json/i.test(system) && system.includes('"suggestions"'), "JSON instruction missing");
  assert(!system.includes("Left-handed gardeners"), "founder content leaked into the system prompt");
});

step("prompt caps the rejected list at 20 and says (none) when empty", () => {
  const many = Array.from({ length: 30 }, (_, i) => `rejected-${i}`);
  const user = buildSuggestMessages({ claims: [], rejectedStatements: many })[1].content;
  assert(user.includes("rejected-19") && !user.includes("rejected-20"), "not capped at 20");
  assert(MAX_REJECTED_IN_PROMPT === 20, "cap constant drifted");
  assert(
    buildSuggestMessages({ claims: [], rejectedStatements: [] })[1].content.includes("(none)"),
    "empty list not marked",
  );
});

step("canReview and canSetLifecycle accept exactly the right statuses", () => {
  const all = ["suggested", "rejected", "active", "superseded", "retired"];
  assert(all.filter(canReview).join() === "suggested", "canReview wrong");
  assert(all.filter(canSetLifecycle).join() === "active,superseded,retired", "canSetLifecycle wrong");
  assert(LIFECYCLE_STATUSES.map((s) => s.value).join() === "active,superseded,retired", "lifecycle list wrong");
});

step("review form: accept/reject only, statement bounds, note optional", () => {
  assert(reviewInputSchema.safeParse({ action: "accept" }).success, "bare accept rejected");
  assert(reviewInputSchema.safeParse({ action: "reject" }).success, "bare reject rejected");
  assert(!reviewInputSchema.safeParse({ action: "delete" }).success, "unknown action accepted");
  assert(!reviewInputSchema.safeParse({}).success, "missing action accepted");
  assert(!reviewInputSchema.safeParse({ action: "accept", statement: "   " }).success, "blank statement accepted");
  assert(
    !reviewInputSchema.safeParse({ action: "accept", statement: "x".repeat(281) }).success,
    "long statement accepted",
  );
  assert(
    !reviewInputSchema.safeParse({ action: "accept", statement: "ok", riskNote: "x".repeat(281) }).success,
    "long note accepted",
  );
  const crlf = reviewInputSchema.safeParse({ action: "accept", statement: " a\r\nb ", riskNote: "" });
  assert(crlf.success && crlf.data.statement === "a\nb" && crlf.data.riskNote === "", "not normalised");
  const absent = reviewInputSchema.safeParse({ action: "accept" });
  assert(
    absent.success && absent.data.riskNote === undefined && absent.data.statement === undefined,
    "absent fields not preserved",
  );
});

step("lifecycle form accepts only the three durable statuses", () => {
  for (const s of ["active", "superseded", "retired"])
    assert(lifecycleInputSchema.safeParse({ status: s }).success, `${s} rejected`);
  for (const s of ["suggested", "rejected", "", "ACTIVE"])
    assert(!lifecycleInputSchema.safeParse({ status: s }).success, `${s} accepted`);
});

step("computeReviewUpdate: reject leaves wording alone; accept flags edits only when text changed", () => {
  const current = { statement: "Gardeners pay monthly", risk_note: "Price is a guess" };
  const parseReview = (v) => reviewInputSchema.parse(v);

  const reject = computeReviewUpdate(
    current,
    parseReview({ action: "reject", statement: "ignored", riskNote: "ignored" }),
  );
  assert(reject.status === "rejected" && !("statement" in reject) && !("edited" in reject), "reject touched wording");

  const same = computeReviewUpdate(
    current,
    parseReview({ action: "accept", statement: "  Gardeners pay monthly ", riskNote: "Price is a guess" }),
  );
  assert(same.status === "active" && same.edited === false && !("statement" in same), "whitespace counted as an edit");

  const bare = computeReviewUpdate(current, parseReview({ action: "accept" }));
  assert(bare.status === "active" && bare.edited === false && !("risk_note" in bare), "bare accept changed something");

  const cleared = computeReviewUpdate(
    current,
    parseReview({ action: "accept", statement: "Gardeners pay monthly", riskNote: "" }),
  );
  assert(cleared.edited === true && cleared.risk_note === null, "an explicitly emptied note was not cleared");

  const reworded = computeReviewUpdate(
    current,
    parseReview({ action: "accept", statement: "Gardeners pay yearly", riskNote: "Price is a guess" }),
  );
  assert(
    reworded.edited === true &&
      reworded.statement === "Gardeners pay yearly" &&
      reworded.risk_note === "Price is a guess",
    "edit not applied",
  );
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
console.log(failed ? `\n${failed} step(s) failed` : `\nAll ${steps.length} assumption checks passed`);
process.exit(failed ? 1 : 0);
