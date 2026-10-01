---
change_id: resumable-rehearsal-sessions
title: Resume disrupted rehearsal sessions without losing or duplicating turns
status: implemented
created: 2026-10-01
updated: 2026-10-01
archived_at: null
---

## Notes

Roadmap slice S-07: context/foundation/roadmap.md (PRD ref: FR-017; prerequisite: S-05, parallel with S-06).

Expired sessions are `ended` with `ended_reason = 'expired'`. They are scored only through S-06's `POST /api/rehearsal/sessions/[id]/score` (page-triggered; there is no automatic scoring on lazy expiry). S-06's `claim_scorecard` already only requires `status = 'ended'`, so `expired` is treated like `user` and `cap`; an expired session with no turns is `insufficient`.
