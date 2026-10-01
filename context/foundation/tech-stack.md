---
starter_id: 10x-astro-starter
package_manager: npm
project_name: unassumed-app
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-workers
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
---

## Why this stack

A solo founder shipping an 8-week, after-hours MVP with auth, AI-driven canvas/assumption/rehearsal features, and a background scoring job needs a battle-tested, agent-friendly starter that handles auth, database, and edge deploy out of the box rather than assembling them by hand. 10x Astro Starter is the recommended default for a TypeScript web app, clears all four agent-friendly gates, and its bootstrapper confidence is first-class. Feature flags for auth, AI, and background jobs are set; payments and realtime are out of scope per the PRD's non-goals. Deployment targets Cloudflare Workers (the Astro Cloudflare adapter no longer supports Pages) — the same platform family as the existing marketing site (a separate Cloudflare Worker) that must keep working unchanged. CI runs on GitHub Actions with auto-deploy-on-merge, matching the starter's standard shape. The one open item carried into implementation planning: the starter's edge runtime constrains long-running tasks, so rehearsal scoring needs a queue or external worker rather than inline processing.
