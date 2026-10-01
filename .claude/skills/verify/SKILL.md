---
name: verify
description: Run the full lint + build check to verify the current state of the codebase is clean. Use before committing or after a batch of edits.
---

Run these commands in sequence and report the result:

1. `npm run lint` — ESLint with type-checked rules (any error = stop here and report)
2. `npm run build` — production SSR build via @astrojs/cloudflare (requires SUPABASE_URL and SUPABASE_KEY in .env or .dev.vars)

If either step fails, show the error output and suggest a fix. If both pass, confirm the codebase is clean.
