-- Assertions for S-04 (assumptions, assumption_claims, lease, batch function). Run against a reset local DB:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/assumptions.sql
begin;

insert into auth.users (id, email)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'founder-a@example.com'),
       ('bbbbbbbb-0000-0000-0000-000000000002', 'founder-b@example.com');

-- Fixtures written as the table owner: one project and two claims per founder.
create temp table ids as
select
  gen_random_uuid() as project_a, gen_random_uuid() as project_b,
  gen_random_uuid() as claim_a1, gen_random_uuid() as claim_a2, gen_random_uuid() as claim_b1,
  null::uuid as assumption_a, null::uuid as assumption_b;
grant select, update on ids to authenticated;

insert into public.projects (id, workspace_id, brief)
select project_a, (select workspace_id from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
       'Founder A brief that is comfortably long enough.' from ids
union all
select project_b, (select workspace_id from public.workspace_members where user_id = 'bbbbbbbb-0000-0000-0000-000000000002'),
       'Founder B brief that is comfortably long enough.' from ids;

insert into public.canvas_claims (id, project_id, block, position, text, origin)
select claim_a1, project_a, 'channels', 0, 'A claim one', 'ai_draft' from ids
union all select claim_a2, project_a, 'cost_structure', 0, 'A claim two', 'ai_draft' from ids
union all select claim_b1, project_b, 'channels', 0, 'B claim one', 'ai_draft' from ids;

-- B has one pending assumption of their own, created as the owner for the isolation checks.
insert into public.assumptions (project_id, statement) select project_b, 'B pending statement' from ids;
update ids set assumption_b = (select id from public.assumptions where statement = 'B pending statement');

-- ---- Founder A -----------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

do $$
declare
  pa uuid := (select project_a from ids);
  c1 uuid := (select claim_a1 from ids);
  c2 uuid := (select claim_a2 from ids);
  cb uuid := (select claim_b1 from ids);
  aid uuid;
  n int;
  s text;
  before_ts timestamptz;
begin
  -- Atomic batch: two suggestions with provenance links.
  n := public.create_suggested_assumptions(pa, jsonb_build_array(
    jsonb_build_object('statement', 'Gardeners will pay monthly', 'risk_note', 'Pricing is a guess', 'claim_ids', jsonb_build_array(c1, c2)),
    jsonb_build_object('statement', 'Left-handers struggle with tools', 'risk_note', null, 'claim_ids', jsonb_build_array(c1, c1))
  ));
  if n <> 2 then raise exception 'batch should create 2, created %', n; end if;
  select count(*) into n from public.assumptions where status = 'suggested' and origin = 'ai_suggested' and edited = false;
  if n <> 2 then raise exception 'expected 2 pending suggestions, saw %', n; end if;
  select count(*) into n from public.assumption_claims;
  if n <> 3 then raise exception 'expected 3 links (duplicate ignored), saw %', n; end if;
  -- Rows of one batch keep the order they were supplied in.
  select count(distinct created_at) into n from public.assumptions;
  if n <> 2 then raise exception 'batch rows share a created_at (order would be lost), distinct = %', n; end if;
  select statement into s from public.assumptions order by created_at limit 1;
  if s <> 'Gardeners will pay monthly' then raise exception 'batch order not preserved, first was %', s; end if;

  -- A batch with one bad link (B's claim) rolls the whole batch back.
  begin
    perform public.create_suggested_assumptions(pa, jsonb_build_array(
      jsonb_build_object('statement', 'Good one', 'claim_ids', jsonb_build_array(c1)),
      jsonb_build_object('statement', 'Poisoned', 'claim_ids', jsonb_build_array(cb))
    ));
    raise exception 'link to another founder''s claim was allowed';
  exception when insufficient_privilege then null; end;
  select count(*) into n from public.assumptions;
  if n <> 2 then raise exception 'failed batch left rows behind: %', n; end if;

  -- Client inserts: only pending candidates, with the vocabulary enforced.
  begin
    insert into public.assumptions (project_id, statement, status) values (pa, 'x', 'active');
    raise exception 'direct insert as active was allowed';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.assumptions (project_id, statement, edited) values (pa, 'x', true);
    raise exception 'direct insert with edited=true was allowed';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.assumptions (project_id, statement, status) values (pa, 'x', 'bogus');
    raise exception 'invalid status was accepted';
  exception when check_violation or insufficient_privilege then null; end;
  begin
    insert into public.assumptions (project_id, statement, origin) values (pa, 'x', 'founder');
    raise exception 'invalid origin was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.assumptions (project_id, statement) values (pa, repeat('x', 281));
    raise exception 'over-long statement was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.assumptions (project_id, statement, risk_note) values (pa, 'x', '');
    raise exception 'empty risk note was accepted';
  exception when check_violation then null; end;

  -- Review transition: accept with an edit.
  select id into aid from public.assumptions where statement = 'Gardeners will pay monthly';
  select updated_at into before_ts from public.assumptions where id = aid;
  perform pg_sleep(0.01);
  update public.assumptions set status = 'active', statement = 'Gardeners will pay monthly for tools', edited = true where id = aid;
  select status into s from public.assumptions where id = aid;
  if s <> 'active' then raise exception 'accept failed'; end if;
  if (select updated_at from public.assumptions where id = aid) <= before_ts then
    raise exception 'updated_at was not bumped by the trigger';
  end if;

  -- Once durable: wording is frozen, lifecycle moves freely among the three states.
  begin
    update public.assumptions set statement = 'sneaky rewrite' where id = aid;
    raise exception 'an accepted assumption could be reworded';
  exception when check_violation then null; end;
  begin
    update public.assumptions set edited = false where id = aid;
    raise exception 'the edited flag changed after review';
  exception when check_violation then null; end;
  update public.assumptions set status = 'superseded' where id = aid;
  update public.assumptions set status = 'retired' where id = aid;
  update public.assumptions set status = 'active' where id = aid;
  begin
    update public.assumptions set status = 'suggested' where id = aid;
    raise exception 'a durable assumption went back to suggested';
  exception when check_violation then null; end;
  begin
    update public.assumptions set status = 'rejected' where id = aid;
    raise exception 'a durable assumption was rejected';
  exception when check_violation then null; end;
  begin
    update public.assumptions set project_id = (select project_b from ids) where id = aid;
    raise exception 'assumption was moved to another project';
  exception when check_violation or insufficient_privilege then null; end;

  -- Pending ones: cannot jump straight to a lifecycle state; rejected is terminal.
  select id into aid from public.assumptions where statement = 'Left-handers struggle with tools';
  begin
    update public.assumptions set status = 'retired' where id = aid;
    raise exception 'a pending suggestion was retired';
  exception when check_violation then null; end;
  update public.assumptions set status = 'rejected' where id = aid;
  begin
    update public.assumptions set status = 'active' where id = aid;
    raise exception 'a rejected suggestion was reopened';
  exception when check_violation then null; end;

  -- No DELETE for anyone.
  begin
    delete from public.assumptions;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'delete removed % assumptions', n; end if;
  exception when insufficient_privilege then null; -- denied outright: as safe as RLS filtering to zero rows
  end;
  begin
    delete from public.assumption_claims;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'delete removed % links', n; end if;
  exception when insufficient_privilege then null; -- denied outright: as safe as RLS filtering to zero rows
  end;

  -- Suggest lease: first wins, fresh refused, stale retaken, released reusable.
  if not public.claim_suggest_lease(pa) then raise exception 'free suggest lease not claimed'; end if;
  if public.claim_suggest_lease(pa) then raise exception 'fresh suggest lease claimed twice'; end if;
  update public.projects set suggest_started_at = now() - interval '2 minutes' where id = pa;
  if not public.claim_suggest_lease(pa) then raise exception 'stale suggest lease not retaken'; end if;
  update public.projects set suggest_started_at = null where id = pa;
  if not public.claim_suggest_lease(pa) then raise exception 'released suggest lease not reusable'; end if;
  -- The draft lease is independent of the suggest lease.
  if not public.claim_draft_lease(pa) then raise exception 'draft lease blocked by suggest lease'; end if;
end $$;

-- Remember A's assumption id for the isolation checks.
reset role;
update ids set assumption_a = (select id from public.assumptions where statement like 'Gardeners will pay monthly%');

-- ---- Founder B: isolation --------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'bbbbbbbb-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);

do $$
declare
  pa uuid := (select project_a from ids);
  pb uuid := (select project_b from ids);
  aa uuid := (select assumption_a from ids);
  ca uuid := (select claim_a1 from ids);
  n int;
begin
  select count(*) into n from public.assumptions;
  if n <> 1 then raise exception 'B should see only their own assumption, saw %', n; end if;
  select count(*) into n from public.assumption_claims;
  if n <> 0 then raise exception 'B can see % of A''s links', n; end if;

  update public.assumptions set status = 'retired' where id = aa;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'B updated A''s assumption'; end if;

  begin
    perform public.create_suggested_assumptions(pa, jsonb_build_array(
      jsonb_build_object('statement', 'Injected', 'claim_ids', jsonb_build_array(ca))));
    raise exception 'B created assumptions in A''s project';
  exception when insufficient_privilege then null; end;

  begin
    insert into public.assumption_claims (assumption_id, claim_id)
    values ((select assumption_b from ids), ca);
    raise exception 'B linked their assumption to A''s claim';
  exception when insufficient_privilege then null; end;

  if public.claim_suggest_lease(pa) then raise exception 'B took A''s suggest lease'; end if;
  if not public.claim_suggest_lease(pb) then raise exception 'B could not take their own suggest lease'; end if;
end $$;

-- ---- anon: nothing ----------------------------------------------------------------------------------
reset role;
set local role anon;
do $$
begin
  begin perform 1 from public.assumptions; raise exception 'anon read assumptions';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.assumption_claims; raise exception 'anon read assumption_claims';
  exception when insufficient_privilege then null; end;
  begin perform public.claim_suggest_lease(gen_random_uuid()); raise exception 'anon ran claim_suggest_lease';
  exception when insufficient_privilege then null; end;
  begin perform public.create_suggested_assumptions(gen_random_uuid(), '[]'::jsonb); raise exception 'anon ran the batch function';
  exception when insufficient_privilege then null; end;
  begin perform public.is_assumption_member(gen_random_uuid()); raise exception 'anon ran is_assumption_member';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
rollback;
select 'assumptions: all assertions passed' as result;
