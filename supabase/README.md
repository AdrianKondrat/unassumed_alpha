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
5. `security definer` functions must `set search_path = ''`, use fully-qualified names, and `revoke ... from public, anon` before granting `execute` to the roles that need it.

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
