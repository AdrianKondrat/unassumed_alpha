-- Assertions for F-02 (ai_usage_events). Run against a reset local database:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/ai_usage_events.sql
begin;

insert into auth.users (id, email)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'founder-a@example.com'),
       ('bbbbbbbb-0000-0000-0000-000000000002', 'founder-b@example.com');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

do $$
declare n int;
begin
  -- Own insert succeeds.
  insert into public.ai_usage_events (founder_id, task_kind, model, prompt_tokens, completion_tokens, total_tokens)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'draft', 'openai/gpt-4o-mini', 10, 20, 30);

  -- Inserting a row for another founder is rejected by RLS.
  begin
    insert into public.ai_usage_events (founder_id, task_kind, model, prompt_tokens, completion_tokens, total_tokens)
    values ('bbbbbbbb-0000-0000-0000-000000000002', 'draft', 'm', 1, 1, 2);
    raise exception 'insert for another founder was allowed';
  exception when insufficient_privilege then null; end;

  -- Vocabulary and sanity checks.
  begin
    insert into public.ai_usage_events (founder_id, task_kind, model, prompt_tokens, completion_tokens, total_tokens)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'bogus', 'm', 1, 1, 2);
    raise exception 'invalid task_kind was accepted';
  exception when check_violation then null; end;

  begin
    insert into public.ai_usage_events (founder_id, task_kind, model, prompt_tokens, completion_tokens, total_tokens)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'score', 'm', -1, 1, 0);
    raise exception 'negative token count was accepted';
  exception when check_violation then null; end;

  select count(*) into n from public.ai_usage_events;
  if n <> 1 then raise exception 'A should see exactly 1 usage row, saw %', n; end if;

  -- Append-only: update and delete affect nothing (no policies).
  update public.ai_usage_events set total_tokens = 0;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'update on ledger changed % rows', n; end if;
  delete from public.ai_usage_events;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'delete on ledger removed % rows', n; end if;
end $$;

-- Founder B sees none of A's rows.
reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'bbbbbbbb-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.ai_usage_events;
  if n <> 0 then raise exception 'B can see % of A''s usage rows', n; end if;
end $$;

-- anon has no access at all.
reset role;
set local role anon;
do $$
begin
  begin
    perform 1 from public.ai_usage_events;
    raise exception 'anon could read the ledger';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
rollback;
select 'ai_usage_events: all assertions passed' as result;
