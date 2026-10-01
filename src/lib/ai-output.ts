// Helpers for turning raw model text into trusted data. Shared by every AI-backed slice (canvas draft,
// assumption suggestion, persona scenario, scoring). Pure (no `astro:*`, no `@/`) so plain Node can import
// it with `--experimental-strip-types`.
//
// Model output is untrusted input: it is parsed, validated with zod by the caller, and screened for the
// viability wording the product must never use about a founder's idea (PRD guardrail).

export type JsonResult = { ok: true; value: unknown } | { ok: false };

/**
 * Parses a model reply that should be a single JSON object. Tolerates a surrounding markdown code fence
 * and stray prose around the object, which models add even in JSON mode.
 */
export function extractJson(raw: string): JsonResult {
  const text = raw.trim();
  const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();

  const direct = tryParse(candidate);
  if (direct.ok) return direct;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) return tryParse(candidate.slice(start, end + 1));
  return { ok: false };
}

function tryParse(text: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

// "unvalidated" is fine (the PRD itself calls ideas unvalidated); \b stops it matching inside that word.
const FORBIDDEN_WORDING = /\b(validated|proven)\b/i;

/**
 * Returns the offending word when the text claims an idea is "validated" or "proven", else null.
 * Callers treat a hit as a failed generation, not something to patch up (hard product boundary).
 */
export function findForbiddenWording(text: string): string | null {
  const match = FORBIDDEN_WORDING.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/** The standing instruction every generation prompt carries, so the rule is stated identically everywhere. */
export const NO_VIABILITY_CLAIMS_RULE =
  'Never state or imply that an idea, claim or business is "validated", "proven" or certain to work. ' +
  'Everything here is an untested hypothesis. Do not use the words "validated" or "proven".';
