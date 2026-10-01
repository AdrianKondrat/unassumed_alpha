---
change_id: ai-provider-integration
title: Wire server-only AI-provider call path (OpenRouter)
status: implemented
created: 2026-09-28
updated: 2026-10-01
archived_at: null
---

## Notes

Traces to `F-02` in `context/foundation/roadmap.md`. Foundation, not a user-visible slice.

Outcome: a working server-only AI-provider call path (OpenRouter or equivalent) exists, with hidden-persona and prompt details never surfacing in SSR props, API responses, or telemetry. Not the actual drafting/suggestion/scoring prompts themselves — those live in the slices that consume this path (S-02, S-04, S-05, S-06).

PRD refs: NFR (persona details never leave the server; founder content never used for training or retained beyond the request).

Unlocks: S-02 (AI-drafted canvas), S-04 (assumption suggestion), S-05 (rehearsal turn exchange), and S-06 — the roadmap's north star (rehearsal scorecard).

Open question carried from the roadmap (not blocking): which OpenRouter model(s) power each task, and whether generation tasks (drafting, suggesting) should use a different model than the classification task (scoring). See roadmap `## Open Roadmap Questions` #1.
