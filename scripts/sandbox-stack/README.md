# sandbox-stack

Test-only stand-in for `npx supabase start` in environments **without Docker** (e.g. the cloud build sandbox, where container registries are blocked). It runs real components natively: Postgres 16, GoTrue (Supabase Auth, built from source with Go), PostgREST, a Kong-like gateway on `:54321` (`/auth/v1`, `/rest/v1`), and an SMTP sink with a Mailpit-style API on `:54324`. It applies `supabase/migrations/*.sql` and `seed.sql` like `supabase db reset`, and serves `supabase/templates/*` to GoTrue.

Not for production and not used by CI (CI uses the real Supabase CLI). Requires root, Postgres 16 server binaries, Go, and access to github.com + proxy.golang.org.

```sh
scripts/sandbox-stack/stack.sh setup    # once: build GoTrue, fetch PostgREST, init Postgres (data in /var/lib/pgtest)
scripts/sandbox-stack/stack.sh start    # gateway, SMTP sink, PostgREST, GoTrue (CONFIRM=false => autoconfirm email)
scripts/sandbox-stack/stack.sh reset    # drop public schema, truncate auth.users, re-apply migrations + seed
eval "$(scripts/sandbox-stack/stack.sh keys)"   # API_URL, ANON_KEY, SERVICE_ROLE_KEY
printf 'SUPABASE_URL=%s\nSUPABASE_KEY=%s\n' "$API_URL" "$ANON_KEY" > .dev.vars; cp .dev.vars .env
```

Then `npm run build && npm run preview -- --port 4321` and `npm run smoke`; run SQL assertions with `psql postgresql://postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f supabase/tests/<file>.sql`.

If the sandbox restarts, Postgres must be started again (`start` does that). Gotchas: do not use `pkill -f <name>` in a command line that also contains `<name>` (it kills your own shell); `stop`/`start` kill by listening port instead.
