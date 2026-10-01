---
bootstrapped_at: 2026-09-27T20:04:09Z
starter_id: 10x-astro-starter
starter_name: 10x Astro Starter (Astro + Supabase + Cloudflare)
project_name: unassumed-app
language_family: js
package_manager: npm
cwd_strategy: git-clone
bootstrapper_confidence: first-class
phase_3_status: ok
audit_command: npm audit --json
---

## Hand-off

```yaml
starter_id: 10x-astro-starter
package_manager: npm
project_name: unassumed-app
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-pages
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: first-class
  path_taken: standard
  quality_override: false
  self_check_answers: null
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: true
  has_background_jobs: true
```

### Why this stack

A solo founder shipping an 8-week, after-hours MVP with auth, AI-driven canvas/assumption/rehearsal features, and a background scoring job needs a battle-tested, agent-friendly starter that handles auth, database, and edge deploy out of the box rather than assembling them by hand. 10x Astro Starter is the recommended default for a TypeScript web app, clears all four agent-friendly gates, and its bootstrapper confidence is first-class. Feature flags for auth, AI, and background jobs are set; payments and realtime are out of scope per the PRD's non-goals. Deployment defaults to Cloudflare Pages — the starter's own default and the same platform family as the existing marketing site (a separate Cloudflare Worker) that must keep working unchanged. CI runs on GitHub Actions with auto-deploy-on-merge, matching the starter's standard shape. The one open item carried into implementation planning: the starter's edge runtime constrains long-running tasks, so rehearsal scoring needs a queue or external worker rather than inline processing.

## Pre-scaffold verification

| Signal      | Value                                                               | Severity | Notes                                                            |
| ----------- | ------------------------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| npm package | not run                                                             | n/a      | `cmd_template` starts with `git clone`; no npm CLI to resolve    |
| GitHub repo | przeprogramowani/10x-astro-starter last pushed 2026-09-12T21:16:08Z | fresh    | from card `docs_url`, via `gh api repos/.../. --jq '.pushed_at'` |

## Scaffold log

**Resolved invocation**: `git clone https://github.com/przeprogramowani/10x-astro-starter .bootstrap-scaffold && cd .bootstrap-scaffold && npm install`
**Strategy**: git-clone
**Exit code**: 0
**Files moved**: 22 top-level paths (`.env.example`, `.github`, `.gitignore`, `.husky`, `.nvmrc`, `.prettierrc.json`, `.vscode`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `astro.config.mjs`, `components.json`, `eslint.config.js`, `node_modules`, `package-lock.json`, `package.json`, `public`, `scripts`, `src`, `supabase`, `tsconfig.json`, `wrangler.jsonc`)
**Conflicts (.scaffold siblings)**: none — cwd had no pre-existing `package.json`, `README.md`, `CLAUDE.md`, `AGENTS.md`, or other colliding paths
**.gitignore handling**: moved silently (absent in cwd before scaffold)
**.bootstrap-scaffold cleanup**: deleted (cloned `.git/` removed first, per `git-clone` strategy)

`context/` in cwd was untouched — the scaffold did not ship a `context/` directory, so no drop was needed.

## Post-scaffold audit

**Tool**: npm audit --json
**Summary**: 0 CRITICAL, 0 HIGH, 0 MODERATE, 0 LOW
**Direct vs transitive**: not applicable — 0 findings across 804 total dependencies (377 prod, 269 dev, 167 optional)

Clean tree. No findings in any severity bucket.

## Hints recorded but not acted on

| Hint                    | Value                |
| ----------------------- | -------------------- |
| bootstrapper_confidence | first-class          |
| quality_override        | false                |
| path_taken              | standard             |
| self_check_answers      | null                 |
| team_size               | solo                 |
| deployment_target       | cloudflare-pages     |
| ci_provider             | github-actions       |
| ci_default_flow         | auto-deploy-on-merge |
| has_auth                | true                 |
| has_payments            | false                |
| has_realtime            | false                |
| has_ai                  | true                 |
| has_background_jobs     | true                 |

## Next steps

Next: a future skill will set up agent context (CLAUDE.md, AGENTS.md). For now, your project is scaffolded and verified — happy hacking.

Useful manual steps in the meantime:

- `git init` (if you have not already) to start your own repo history.
- Review any `.scaffold` siblings the conflict policy created and decide which version of each file to keep — none were created this run.
- Address audit findings per your project's risk tolerance — the full breakdown is in this log (none this run).
