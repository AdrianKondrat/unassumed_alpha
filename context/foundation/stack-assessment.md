---
project: unassumed-website
assessed_at: 2026-09-27T00:00:00Z
agent_readiness: ready-with-compensation
context_type: brownfield
stack_components:
  language: TypeScript (strict)
  framework: none (raw Cloudflare Worker fetch handler)
  build_tool: custom Node script (scripts/build.mjs)
  test_runner: null
  package_manager: npm
  ci_provider: null
  deployment_target: Cloudflare Workers + D1 + Resend
gates_passed: 2
gates_failed: 2
---

## Important note before the scoring

This assessment is of **what actually exists on disk** at `/Users/adriankondrat/Documents/UNASSUMED (lean founder)/Website` (git remote: `github.com/AdrianKondrat/unassumed_alpha`, currently on its default branch). It does **not** match the stack described in `context/foundation/prd.md`'s "Current System Overview," which was inherited from the technical specification's assumed baseline (Astro, React, Supabase, Cloudflare Workflows, OpenRouter). None of that exists in this repository. What's actually here is a deliberately minimal, framework-free marketing site.

**Practical consequence:** almost the entire MVP scope defined in the PRD (auth, personal workspaces, canvas AI drafting, assumption tracking, the rehearsal engine) is net-new — there is no existing framework, database client, or AI integration to evaluate for those pieces, because none of them exist yet in this codebase. This assessment can only score the one thing that's real: the marketing site + waitlist infrastructure the MVP must preserve (FR-018) and will likely build alongside. Choosing the stack for the net-new MVP components is closer to a greenfield decision than a brownfield evaluation — see the recommendation at the end.

## Stack Components

**Language — TypeScript, strict mode.** `tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`, and `noFallthroughCasesInSwitch`. This is a rigorous configuration, well above the TypeScript default.

**Framework — none, by design.** The README states this explicitly: "No framework, no bundler, no runtime dependencies." Routing is a manual dispatch in `src/index.ts` (`/api/waitlist`, `/api/*` → 404, everything else → 404 page); static assets in `public/` are served directly from Cloudflare's edge without ever invoking the Worker. This is the canonical minimal-Workers pattern, not a stripped-down framework.

**Build tool — a single custom script.** `scripts/build.mjs` (invoked via `npm run build`) does exactly two things: propagates `SITE_ORIGIN` into canonical URLs/OG tags/sitemap/robots.txt, and regenerates `public/_headers` (including a SHA-256 hash of the inline JSON-LD block, which is what lets the CSP drop `unsafe-inline`). There is no bundler in the traditional sense — `wrangler dev`/`wrangler deploy` handle Worker bundling internally via esbuild (a `wrangler` dependency, not a project choice).

**Test runner — not present.** No test framework is configured, and no test files exist. Reasonable for a site of this size (six small `src/*.ts` files, no branching business logic to speak of), but it's a real gap the moment the MVP application's actual domain logic (assumption lifecycle, rehearsal scoring) lands in this repo.

**Package manager — npm** (`package-lock.json` present).

**CI/CD — not present.** No `.github/workflows/`, no other CI config. `npm run check` (build + typecheck + `wrangler deploy --dry-run`) is documented as the pre-push ritual, but nothing enforces it automatically.

**Deployment — Cloudflare Workers**, with static assets served from Cloudflare's edge (`run_worker_first` unset, so asset requests never invoke the Worker), a D1 database (`unassumed-alpha`, SQLite) for waitlist storage, and Resend for transactional email. Rate limiting is a native Cloudflare `ratelimits` binding (5 requests/60s per IP) rather than application code.

**Instruction files — none.** No `CLAUDE.md` or `AGENTS.md`. The README itself is unusually thorough and effectively serves as a hand-written conventions document (see "How it is put together" and the abuse-control table), which is why the framework gap below is scored as a partial pass rather than an outright fail.

## Quality Gate Assessment

| Component                                  | Typed | Convention | Training Data | Documented | Verdict        |
| ------------------------------------------ | ----- | ---------- | ------------- | ---------- | -------------- |
| Language (TypeScript, strict)              | ✓     | —          | —             | —          | pass           |
| Runtime pattern (raw Worker fetch handler) | —     | ~          | ✓             | ✓          | pass-with-note |
| Build tool (custom `build.mjs`)            | —     | ✗          | ✗             | ✗          | fail           |
| Test runner                                | —     | —          | ✗             | ✗          | fail (absent)  |

Legend: ✓ = pass, ✗ = fail, ~ = partial, — = not applicable

### Gate Details

**Typed — pass.** `tsconfig.json` proves it: `strict: true` plus several stricter-than-default flags. Evidence is unambiguous.

**Convention-based (runtime pattern) — partial pass.** There's no framework to enforce structure, so nothing stops a future contributor from laying out a second route differently from `waitlist.ts`. But the README's "How it is put together" table documents the actual convention in detail (one file per concern: routing, validation, storage, email, security, env), which is the documented-conventions escape hatch for a minimal setup.

**Popular in training data (runtime pattern) — pass.** `export default { fetch(request, env) {...} }` is Cloudflare's own canonical Workers quickstart pattern — extremely well represented in training data. An agent will not need to be taught this shape.

**Well-documented (runtime pattern) — pass.** Cloudflare's Workers fetch-handler docs are current, versioned, and extensive.

**Build tool — fail on all three applicable gates.** `scripts/build.mjs` is bespoke: no external convention governs it, an agent has not seen this exact script before (it must read it fresh every time), and there are no official docs for a one-off script — only the inline comments and the README's brief description. Low severity in practice: the script is short and its two responsibilities are stated plainly in both the file and the README.

**Test runner — absent.** Nothing to score against training-data popularity or documentation quality because nothing is configured. This is a straightforward gap, not a judgment call.

## Gaps & Compensation

### Gap 1: No test runner

No test framework exists. Reasonable for the current six-file marketing site; not reasonable once the MVP's actual domain logic (rehearsal scoring, assumption lifecycle transitions) lands here — that logic has enough branching to need direct verification, independent of the manual E2E checks the PRD's success criteria describe.

**Compensation — recommended instruction-file addition:**

```markdown
## Testing

No test suite exists yet for the marketing site. When adding tests for new
application logic (rehearsal scoring, assumption transitions, etc.), use
`vitest` with `@cloudflare/vitest-pool-workers` — Cloudflare's official
Workers-native test runner, which runs tests against the real `workerd`
runtime instead of Node polyfills. Do not introduce a generic Node test
runner (e.g. plain Jest) for Worker-bound code; it will pass locally and
fail against real Workers APIs (D1, KV, rate limiters).
```

### Gap 2: Bespoke, undocumented-externally build script

`scripts/build.mjs` has no framework or published-tool docs backing it — an agent (or a new contributor) must read the script itself every time to know what it does.

**Compensation — recommended instruction-file addition:**

```markdown
## Build

`npm run build` runs `scripts/build.mjs`, a single custom Node ESM script
(no bundler). It does exactly two things: (1) propagates `vars.SITE_ORIGIN`
from `wrangler.jsonc` into every canonical URL, Open Graph tag,
`sitemap.xml`, and `robots.txt` entry; (2) regenerates `public/_headers`,
including the SHA-256 hash of the inline JSON-LD block that the CSP needs
to drop `unsafe-inline`. Any change to an inline `<script>` or `<style>` in
`public/` REQUIRES re-running `npm run build`, or the CSP will silently
block it in production.
```

### Gap 3 (noted, not a formal gate): No CI/CD

No automated pipeline runs `npm run check` on push/PR — it's a documented manual ritual only. Not scored as one of the four gates, but worth `/10x-health-check`'s attention once the MVP branch adds real application logic, since a framework-free repo with no CI has nothing else catching a bad merge.

## Summary

**Verdict: ready-with-compensation** — for what actually exists. The marketing site itself is small, cleanly typed, and unusually well-documented in its README even without a formal instruction file; the two gate failures (bespoke build script, absent tests) are low-severity for a six-file static site and have concrete, ready-to-paste compensation above.

**The larger finding:** this assessment could only meaningfully score the marketing-site infrastructure, because that is the only part of `unassumed_alpha` that exists. The MVP scope in `context/foundation/prd.md` — auth, personal workspaces, canvas AI drafting, assumption tracking, the rehearsal engine — has no existing framework, database client, or AI integration in this repo to evaluate. Deciding how to build those net-new pieces (which web framework if any, which database — keep D1 or add something else, which AI provider) is a **stack-selection decision, not a stack-assessment one**, even though it will land inside this same brownfield repository on the MVP branch.

**Recommended next step:** run `/10x-tech-stack-selector` for the net-new MVP application components, treating "must keep the existing Cloudflare Workers + D1 marketing site working unchanged" (FR-018) as a hard constraint on the selection rather than skipping selection entirely. After that, `/10x-health-check` can audit the combined repo (existing site + new MVP code) for CI, dependency, and test coverage gaps.
