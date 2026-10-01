// Offline checks for src/lib/services/canvas-edit.ts (input schemas, allow-listed claim shape, status mapping).
// No network. Run: npm run test:canvas-edit
import {
  BLOCK_CLAIM_CAP,
  claimTextSchema,
  createClaimSchema,
  deleteClaimSchema,
  statusForClaimCode,
  toPublicClaim,
  updateClaimSchema,
} from "../src/lib/services/canvas-edit.ts";
import { CANVAS_BLOCKS, CLAIM_MAX_LENGTH } from "../src/lib/services/canvas-draft.ts";

const steps = [];
const step = (name, fn) => steps.push([name, fn]);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const text = (value) => claimTextSchema.safeParse(value);

step("claim text is trimmed and line breaks collapse to single spaces", () => {
  const r = text("  Gardeners hate\r\n\n  right-handed   tools \n");
  assert(r.success && r.data === "Gardeners hate right-handed   tools", `got ${JSON.stringify(r.data)}`);
});

step("claim text accepts exactly the database maximum and refuses one more", () => {
  assert(CLAIM_MAX_LENGTH === 280, `max is ${CLAIM_MAX_LENGTH}`);
  assert(text("x".repeat(280)).success, "280 refused");
  assert(!text("x".repeat(281)).success, "281 accepted");
});

step("claim text refuses empty, whitespace-only, and non-strings", () => {
  for (const value of ["", "   ", "\n\r\n", undefined, null, 7, {}]) {
    assert(!text(value).success, `accepted ${JSON.stringify(value)}`);
  }
});

step("the length bound applies after trimming and collapsing, not before", () => {
  assert(text(`${"x".repeat(280)}   \n  `).success, "trailing whitespace counted toward the limit");
  assert(!text(`${"x".repeat(200)}\n${"y".repeat(100)}`).success, "a collapsed 301-char claim was accepted");
});

step("create accepts every known block and refuses unknown ones", () => {
  for (const block of CANVAS_BLOCKS)
    assert(createClaimSchema.safeParse({ block: block.key, text: "A claim" }).success, `refused ${block.key}`);
  assert(CANVAS_BLOCKS.length === 9, "the canvas has nine blocks");
  for (const block of ["", "Channels", "revenue", undefined, 3]) {
    assert(!createClaimSchema.safeParse({ block, text: "A claim" }).success, `accepted block ${JSON.stringify(block)}`);
  }
});

step("update and delete need a positive integer revision", () => {
  assert(updateClaimSchema.safeParse({ text: "x", expectedRevision: 1 }).success, "revision 1 refused");
  assert(updateClaimSchema.safeParse({ text: "x", expectedRevision: 40 }).success, "revision 40 refused");
  for (const expectedRevision of [0, -1, 1.5, "1", null, undefined, Number.NaN]) {
    assert(
      !updateClaimSchema.safeParse({ text: "x", expectedRevision }).success,
      `update accepted ${expectedRevision}`,
    );
    assert(!deleteClaimSchema.safeParse({ expectedRevision }).success, `delete accepted ${expectedRevision}`);
  }
  assert(deleteClaimSchema.safeParse({ expectedRevision: 2 }).success, "delete revision 2 refused");
});

step("a request cannot smuggle the server-owned fields in", () => {
  const parsed = updateClaimSchema.parse({
    text: "x",
    expectedRevision: 2,
    origin: "ai_draft",
    revision: 99,
    block: "channels",
  });
  assert(Object.keys(parsed).sort().join() === "expectedRevision,text", `kept ${Object.keys(parsed).join()}`);
  const created = createClaimSchema.parse({
    block: "channels",
    text: "x",
    position: 0,
    origin: "ai_draft",
    project_id: "p",
  });
  assert(Object.keys(created).sort().join() === "block,text", `kept ${Object.keys(created).join()}`);
});

step("a claim leaves the server as exactly six allow-listed fields", () => {
  const row = {
    id: "c1",
    block: "channels",
    position: 2,
    text: "t",
    origin: "founder",
    revision: 3,
    project_id: "secret-project",
    created_at: "2026-01-01",
    draft_started_at: "x",
  };
  const out = toPublicClaim(row);
  assert(
    Object.keys(out).sort().join() === "block,id,origin,position,revision,text",
    `fields: ${Object.keys(out).join()}`,
  );
  assert(JSON.stringify(out).includes("secret-project") === false, "project id leaked");
});

step("error codes map to the right HTTP status", () => {
  const expected = {
    not_found: 404,
    conflict: 409,
    block_full: 409,
    invalid: 400,
    server_error: 500,
    anything_else: 500,
  };
  for (const [code, status] of Object.entries(expected))
    assert(statusForClaimCode(code) === status, `${code} -> ${statusForClaimCode(code)}`);
});

step("the per-block cap matches the database (12)", () => {
  assert(BLOCK_CLAIM_CAP === 12, `cap is ${BLOCK_CLAIM_CAP}`);
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
console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${steps.length} checks passed`);
process.exit(failed ? 1 : 0);
