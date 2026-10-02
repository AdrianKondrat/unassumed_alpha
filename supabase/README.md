# Supabase: migrations, RLS pattern, tests

## Adding a migration

- Create it with `npx supabase migration new <short_description>` (produces `supabase/migrations/YYYYMMDDHHmmss_short_description.sql`).
- One migration per slice's data contract, so it lands or fails as a whole.
- Apply on a clean local stack with `npx supabase db reset` (runs all migrations, then `seed.sql`, which is intentionally empty).
- Keep migrations compatible with Postgres 17 (`major_version` in `config.toml`).

## RLS pattern (every table, no exceptions)

1. `alter table public.<t> enable row level security;`
2. One policy per operation (`select`, `insert`, `update`, `delete`), each `to authenticated` only. Never write `anon` policies for tenant data; revoke `anon` privileges on the table as defence in depth.
3. Gate tenant rows with `public.is_workspace_member(workspace_id)`, wrapped as `(select public.is_workspace_member(workspace_id))` so Postgres evaluates it once per statement rather than per row.
   For tables that hang off a project, gate through the project's workspace (a small `security definer` helper with `set search_path = ''` is fine).
4. Only add the operations a client genuinely needs. Server-written tables get no client `insert/update/delete` policy and are written with the service-role client.
5. **State your privileges explicitly.** Never rely on Supabase's default grants (they are a project setting on hosted projects). Every new table's migration must `grant` `authenticated` exactly the operations its policies allow (and `service_role` full access if server code touches it), and every function must `revoke ... from public, anon` and then grant `execute` only to the roles that need it. `20261002090000_explicit_api_grants.sql` did this for the first 13 tables; append new tables to `supabase/checks/hosted_verification.sql` (the table, founder-grant and function lists at the top) so the check keeps covering them.
6. `security definer` functions must `set search_path = ''`, use fully-qualified names, and `revoke ... from public, anon` before granting `execute` to the roles that need it.

`workspaces` and `workspace_members` are created by the `on_auth_user_created` trigger on `auth.users` (one personal workspace + one owner membership per founder, atomically with signup). App code never inserts them.

## Tests

SQL assertion scripts live in `supabase/tests/*.sql`. Each runs in a single transaction that is rolled back, and raises an exception on any failed assertion. Run them against a reset local database:

```sh
npx supabase db reset
for f in supabase/tests/*.sql; do
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f "$f" || exit 1
done
```

To impersonate a founder inside a test, use `set local role authenticated;` and `select set_config('request.jwt.claims', json_build_object('sub', '<user uuid>', 'role', 'authenticated')::text, true);`, then `reset role;` before switching to another user.

## Hosted-readiness checks

`supabase/checks/hosted_verification.sql` is a **read-only** script that must report `ALL PASS`: tables exist, RLS on, anon has nothing, founders have exactly the privileges the app needs, the hidden persona table is invisible to clients, server-only functions are service-role-only, the signup trigger exists. CI runs it against the local CLI database; run it in the Supabase SQL editor after applying migrations to a hosted project (see `HOSTED_SETUP.md`).

To prove the migrations do not depend on default grants, run `scripts/sandbox-stack/check-without-default-grants.sh` (sandbox stack) or, with Docker, apply the migrations after `alter default privileges in schema public revoke all on tables from anon, authenticated, service_role;` and rerun the tests.
