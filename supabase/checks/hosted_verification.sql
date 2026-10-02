-- Read-only verification of a Supabase database after the migrations have been applied.
-- Paste into the Supabase dashboard -> SQL Editor and run (or: psql "<connection string>" -f this file).
-- It only SELECTs: it changes nothing and creates no data, so it is safe on a live project.
--
-- Every row must say PASS. A FAIL row names exactly what is wrong; see supabase/HOSTED_SETUP.md, step 7.

with
app_tables(t) as (values
  ('workspaces'), ('workspace_members'), ('ai_usage_events'), ('projects'), ('canvas_claims'),
  ('assumptions'), ('assumption_claims'), ('rehearsal_sessions'), ('rehearsal_turns'),
  ('rehearsal_scenarios'), ('scorecards'), ('scorecard_flags'), ('scorecard_rewrites')
),
-- Operations a signed-in founder (role `authenticated`) must be able to perform, mirroring the RLS policies.
founder_grants(t, p) as (values
  ('workspaces','SELECT'), ('workspaces','UPDATE'), ('workspace_members','SELECT'),
  ('ai_usage_events','SELECT'), ('ai_usage_events','INSERT'),
  ('projects','SELECT'), ('projects','INSERT'), ('projects','UPDATE'),
  ('canvas_claims','SELECT'), ('canvas_claims','INSERT'), ('canvas_claims','UPDATE'), ('canvas_claims','DELETE'),
  ('assumptions','SELECT'), ('assumptions','INSERT'), ('assumptions','UPDATE'),
  ('assumption_claims','SELECT'), ('assumption_claims','INSERT'),
  ('rehearsal_sessions','SELECT'), ('rehearsal_turns','SELECT'),
  ('scorecards','SELECT'), ('scorecard_flags','SELECT'), ('scorecard_rewrites','SELECT')
),
-- Functions only the server (service_role) may call. Founders and anon must NOT be able to execute them.
service_only_fns(sig) as (values
  ('public.start_rehearsal_session(uuid,jsonb)'), ('public.rehearsal_add_turn(uuid,text,uuid)'),
  ('public.rehearsal_claim_reply(uuid,integer)'), ('public.rehearsal_release_reply(uuid,integer)'),
  ('public.rehearsal_expire_idle(uuid)'), ('public.rehearsal_store_reply(uuid,integer,text)'),
  ('public.rehearsal_end_session(uuid,text)'), ('public.claim_scorecard(uuid)'),
  ('public.store_scorecard(uuid,text,text,text,text,jsonb,jsonb)')
),
-- Functions a signed-in founder calls (RLS helpers, leases, atomic inserts). anon must NOT be able to execute them.
founder_fns(sig) as (values
  ('public.is_workspace_member(uuid)'), ('public.is_project_member(uuid)'), ('public.is_assumption_member(uuid)'),
  ('public.is_rehearsal_session_member(uuid)'), ('public.claim_draft_lease(uuid)'), ('public.claim_suggest_lease(uuid)'),
  ('public.create_suggested_assumptions(uuid,jsonb)'), ('public.add_canvas_claim(uuid,text,text)')
),
checks(ord, name, ok, detail) as (

  select 10, 'all 13 app tables exist',
         (select count(*) from app_tables a where to_regclass('public.' || a.t) is not null) = 13,
         'missing: ' || coalesce((select string_agg(a.t, ', ') from app_tables a where to_regclass('public.' || a.t) is null), 'none')

  union all
  select 20, 'row level security is enabled on every app table',
         not exists (select 1 from app_tables a join pg_class c on c.oid = to_regclass('public.' || a.t) where not c.relrowsecurity),
         'RLS off on: ' || coalesce((select string_agg(a.t, ', ') from app_tables a join pg_class c on c.oid = to_regclass('public.' || a.t) where not c.relrowsecurity), 'none')

  union all
  select 30, 'no RLS policy targets anon or public on any app table',
         not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename in (select t from app_tables)
                       and (p.roles && array['anon','public']::name[])),
         'offending policies: ' || coalesce((select string_agg(p.tablename || '.' || p.policyname, ', ') from pg_policies p
            where p.schemaname = 'public' and p.tablename in (select t from app_tables) and (p.roles && array['anon','public']::name[])), 'none')

  union all
  select 40, 'anon has no privilege on any app table',
         not exists (select 1 from app_tables a, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
                      where to_regclass('public.' || a.t) is not null and has_table_privilege('anon', 'public.' || a.t, p)),
         'anon can: ' || coalesce((select string_agg(a.t || ':' || p, ', ') from app_tables a, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
            where to_regclass('public.' || a.t) is not null and has_table_privilege('anon', 'public.' || a.t, p)), 'nothing')

  union all
  select 50, 'founders (authenticated) have every privilege the app needs',
         not exists (select 1 from founder_grants g where to_regclass('public.' || g.t) is not null
                       and not has_table_privilege('authenticated', 'public.' || g.t, g.p)),
         'missing: ' || coalesce((select string_agg(g.t || ':' || g.p, ', ') from founder_grants g
            where to_regclass('public.' || g.t) is not null and not has_table_privilege('authenticated', 'public.' || g.t, g.p)), 'none')

  union all
  select 60, 'founders cannot write rehearsal sessions, turns, scenarios or scorecards',
         not exists (select 1 from unnest(array['rehearsal_sessions','rehearsal_turns','rehearsal_scenarios','scorecards','scorecard_flags','scorecard_rewrites']) t,
                            unnest(array['INSERT','UPDATE','DELETE']) p
                      where to_regclass('public.' || t) is not null and has_table_privilege('authenticated', 'public.' || t, p)),
         'founders can write: ' || coalesce((select string_agg(t || ':' || p, ', ') from unnest(array['rehearsal_sessions','rehearsal_turns','rehearsal_scenarios','scorecards','scorecard_flags','scorecard_rewrites']) t,
            unnest(array['INSERT','UPDATE','DELETE']) p where to_regclass('public.' || t) is not null and has_table_privilege('authenticated', 'public.' || t, p)), 'nothing')

  union all
  select 70, 'the hidden persona table is invisible to every client role (no policy, no privilege)',
         to_regclass('public.rehearsal_scenarios') is not null
         and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'rehearsal_scenarios')
         and not has_table_privilege('authenticated', 'public.rehearsal_scenarios', 'SELECT')
         and not has_table_privilege('anon', 'public.rehearsal_scenarios', 'SELECT'),
         'a founder or anon could read the persona scenario, or a policy exists on it'

  union all
  select 80, 'service_role has full access to every app table (the server needs it)',
         not exists (select 1 from app_tables a, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
                      where to_regclass('public.' || a.t) is not null and not has_table_privilege('service_role', 'public.' || a.t, p)),
         'service_role lacks: ' || coalesce((select string_agg(a.t || ':' || p, ', ') from app_tables a, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
            where to_regclass('public.' || a.t) is not null and not has_table_privilege('service_role', 'public.' || a.t, p)), 'nothing')

  union all
  select 90, 'server-only functions are executable by service_role only',
         not exists (select 1 from service_only_fns f where to_regprocedure(f.sig) is null)
         and not exists (select 1 from service_only_fns f, unnest(array['anon','authenticated']) r
                          where to_regprocedure(f.sig) is not null and has_function_privilege(r, to_regprocedure(f.sig), 'EXECUTE'))
         and not exists (select 1 from service_only_fns f where to_regprocedure(f.sig) is not null
                          and not has_function_privilege('service_role', to_regprocedure(f.sig), 'EXECUTE')),
         'problems: ' || coalesce((select string_agg(f.sig, ', ') from service_only_fns f where to_regprocedure(f.sig) is null
            or exists (select 1 from unnest(array['anon','authenticated']) r where has_function_privilege(r, f.sig::regprocedure, 'EXECUTE'))), 'see grants')

  union all
  select 100, 'founder functions exist, authenticated can run them and anon cannot',
         not exists (select 1 from founder_fns f where to_regprocedure(f.sig) is null)
         and not exists (select 1 from founder_fns f where to_regprocedure(f.sig) is not null
                          and (not has_function_privilege('authenticated', to_regprocedure(f.sig), 'EXECUTE')
                               or has_function_privilege('anon', to_regprocedure(f.sig), 'EXECUTE'))),
         'problems: ' || coalesce((select string_agg(f.sig, ', ') from founder_fns f where to_regprocedure(f.sig) is null
            or not has_function_privilege('authenticated', f.sig::regprocedure, 'EXECUTE')
            or has_function_privilege('anon', f.sig::regprocedure, 'EXECUTE')), 'none')

  union all
  select 110, 'signup trigger on auth.users is present and enabled (one workspace per founder)',
         exists (select 1 from pg_trigger t where t.tgrelid = 'auth.users'::regclass and t.tgname = 'on_auth_user_created' and t.tgenabled = 'O'),
         'trigger on_auth_user_created missing or disabled: founders would get no workspace'

  union all
  select 120, 'every migration has been applied (9 expected)',
         case when to_regclass('supabase_migrations.schema_migrations') is null
              then (select count(*) from app_tables a where to_regclass('public.' || a.t) is not null) = 13
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from supabase_migrations.schema_migrations', false, true, '')))[1]::text::int >= 9 end,
         case when to_regclass('supabase_migrations.schema_migrations') is null
              then 'migrations were not applied with the Supabase CLI and the app tables are missing: apply supabase/migrations/*.sql in order'
              else 'applied: ' || (xpath('/row/c/text()', query_to_xml('select count(*) as c from supabase_migrations.schema_migrations', false, true, '')))[1]::text::int::text || ' of 9' end

  union all
  select 130, 'every app table has at least one policy (RLS without policies would block everything)',
         not exists (select 1 from app_tables a where a.t <> 'rehearsal_scenarios'
                       and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = a.t)),
         'no policies on: ' || coalesce((select string_agg(a.t, ', ') from app_tables a where a.t <> 'rehearsal_scenarios'
            and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = a.t)), 'none')
)
select r.name as check, r.status, r.detail
from (
  select ord, name,
         case when ok then 'PASS' else 'FAIL' end as status,
         case when ok then '' else detail end as detail
  from checks
  union all
  select 999, 'SUMMARY',
         case when bool_and(ok) then 'ALL PASS' else count(*) filter (where not ok)::text || ' FAILED' end,
         ''
  from checks
) r
order by r.ord;
