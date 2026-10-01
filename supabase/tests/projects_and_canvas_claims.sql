-- Assertions for S-02 (projects, canvas_claims). Run against a reset local database:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/projects_and_canvas_claims.sql
begin;

-- The signup trigger creates one workspace + owner membership per user.
insert into auth.users (id, email)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'founder-a@example.com'),
       ('bbbbbbbb-0000-0000-0000-000000000002', 'founder-b@example.com');

create temp table ids as
select
  (select workspace_id from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-000000000001') as ws_a,
  (select workspace_id from public.workspace_members where user_id = 'bbbbbbbb-0000-0000-0000-000000000002') as ws_b,
  null::uuid as project_a;
grant select on ids to authenticated;

-- ---- Founder A: cap, vocabulary, own data ------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

do $$
declare
  ws_a uuid := (select ws_a from ids);
  ws_b uuid := (select ws_b from ids);
  pid uuid;
  n int;
begin
  insert into public.projects (workspace_id, brief)
  values (ws_a, 'A subscription box for left-handed gardeners, sold online.')
  returning id into pid;

  -- One project per workspace: a second is rejected.
  begin
    insert into public.projects (workspace_id, brief) values (ws_a, 'A second project that must not be allowed.');
    raise exception 'second project in the same workspace was allowed';
  exception when unique_violation then null; end;

  -- Brief length bounds.
  begin
    update public.projects set brief = 'too short' where id = pid;
    raise exception 'short brief was accepted';
  exception when check_violation then null; end;
  begin
    update public.projects set brief = repeat('x', 2001) where id = pid;
    raise exception 'over-long brief was accepted';
  exception when check_violation then null; end;

  -- Cannot create a project in someone else's workspace.
  begin
    insert into public.projects (workspace_id, brief) values (ws_b, 'Trying to write into the other founder workspace.');
    raise exception 'project in another workspace was allowed';
  exception when insufficient_privilege then null; end;

  -- Claims: valid insert and defaults.
  insert into public.canvas_claims (project_id, block, position, text, origin)
  values (pid, 'value_propositions', 0, 'Gardening tools designed for left-handed use.', 'ai_draft');

  select count(*) into n from public.canvas_claims where revision = 1 and origin = 'ai_draft';
  if n <> 1 then raise exception 'default revision / origin not as expected'; end if;

  -- Vocabulary and bounds.
  begin
    insert into public.canvas_claims (project_id, block, position, text, origin)
    values (pid, 'not_a_block', 0, 'x', 'ai_draft');
    raise exception 'invalid block was accepted';
  exception when check_violation then null; end;

  begin
    insert into public.canvas_claims (project_id, block, position, text, origin)
    values (pid, 'channels', 0, 'x', 'robot');
    raise exception 'invalid origin was accepted';
  exception when check_violation then null; end;

  begin
    insert into public.canvas_claims (project_id, block, position, text, origin)
    values (pid, 'channels', 0, repeat('x', 281), 'ai_draft');
    raise exception 'over-long claim was accepted';
  exception when check_violation then null; end;

  begin
    insert into public.canvas_claims (project_id, block, position, text, origin)
    values (pid, 'channels', 0, '', 'ai_draft');
    raise exception 'empty claim was accepted';
  exception when check_violation then null; end;

  begin
    insert into public.canvas_claims (project_id, block, position, text, origin)
    values (pid, 'value_propositions', 0, 'Same slot again.', 'ai_draft');
    raise exception 'duplicate (project, block, position) was accepted';
  exception when unique_violation then null; end;

  -- Claim UPDATE and DELETE arrived with S-03 (see canvas_claims_editing.sql). Projects still have no client DELETE.
  delete from public.projects;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'project delete affected % rows', n; end if;

  -- Draft lease: first claim wins, second is refused while fresh, a stale lease can be retaken, a
  -- released lease can be claimed again.
  if not public.claim_draft_lease(pid) then raise exception 'owner could not claim a free lease'; end if;
  if public.claim_draft_lease(pid) then raise exception 'a fresh lease was claimed twice'; end if;
  update public.projects set draft_started_at = now() - interval '2 minutes' where id = pid;
  if not public.claim_draft_lease(pid) then raise exception 'a stale lease could not be retaken'; end if;
  update public.projects set draft_started_at = null where id = pid;
  if not public.claim_draft_lease(pid) then raise exception 'a released lease could not be claimed'; end if;
  update public.projects set draft_started_at = null where id = pid;
  if public.claim_draft_lease(gen_random_uuid()) then raise exception 'claimed a lease on a nonexistent project'; end if;
end $$;

-- Remember A's project id for the isolation checks (reading it as the table owner).
reset role;
update ids set project_a = (select id from public.projects where workspace_id = ids.ws_a);

-- ---- Founder B: isolation ----------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'bbbbbbbb-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);

do $$
declare
  ws_b uuid := (select ws_b from ids);
  a_project uuid := (select project_a from ids);
  n int;
begin
  if a_project is null then raise exception 'test setup: project_a missing'; end if;

  select count(*) into n from public.projects;
  if n <> 0 then raise exception 'B can see % of A''s projects', n; end if;
  select count(*) into n from public.canvas_claims;
  if n <> 0 then raise exception 'B can see % of A''s claims', n; end if;

  -- B cannot add claims to A's project or modify it.
  begin
    insert into public.canvas_claims (project_id, block, position, text, origin)
    values (a_project, 'channels', 1, 'Injected by another founder.', 'ai_draft');
    raise exception 'B inserted a claim into A''s project';
  exception when insufficient_privilege then null; end;

  update public.projects set brief = 'Overwritten by another founder, long enough.' where id = a_project;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'B updated A''s project'; end if;

  -- B cannot take A's lease (RLS hides the row from B's UPDATE).
  if public.claim_draft_lease(a_project) then raise exception 'B claimed A''s draft lease'; end if;

  -- B can create their own project and sees only that one.
  insert into public.projects (workspace_id, brief) values (ws_b, 'A marketplace for second-hand climbing gear.');
  select count(*) into n from public.projects;
  if n <> 1 then raise exception 'B should see exactly their own project, saw %', n; end if;
end $$;

-- ---- anon: nothing -------------------------------------------------------------------------------
reset role;
set local role anon;
do $$
begin
  begin
    perform 1 from public.projects;
    raise exception 'anon could read projects';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.canvas_claims;
    raise exception 'anon could read canvas_claims';
  exception when insufficient_privilege then null; end;
  begin
    perform public.is_project_member(gen_random_uuid());
    raise exception 'anon could execute is_project_member';
  exception when insufficient_privilege then null; end;
  begin
    perform public.claim_draft_lease(gen_random_uuid());
    raise exception 'anon could execute claim_draft_lease';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
rollback;
select 'projects_and_canvas_claims: all assertions passed' as result;
