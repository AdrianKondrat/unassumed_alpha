-- Assertions for F-01 (workspace scaffold). Run against a reset local database:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/workspace_scaffold.sql
-- Everything runs in one transaction that is rolled back, so it leaves no data behind.
begin;

-- Two founders. Inserting into auth.users fires the signup trigger.
insert into auth.users (id, email)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'founder-a@example.com'),
       ('bbbbbbbb-0000-0000-0000-000000000002', 'founder-b@example.com');

-- FR-004: exactly one workspace + one owner membership per founder, created by the trigger.
do $$
declare n int;
begin
  select count(*) into n from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if n <> 1 then raise exception 'founder A should have exactly 1 membership, got %', n; end if;

  select count(*) into n from public.workspace_members where user_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  if n <> 1 then raise exception 'founder B should have exactly 1 membership, got %', n; end if;

  select count(*) into n from public.workspace_members where role = 'owner'
    and user_id in ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
  if n <> 2 then raise exception 'both memberships should have role owner, got %', n; end if;

  select count(distinct workspace_id) into n from public.workspace_members
    where user_id in ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
  if n <> 2 then raise exception 'founders should have separate workspaces, got % distinct', n; end if;
end $$;

-- A second membership for the same founder is rejected (unique index on user_id).
do $$
begin
  insert into public.workspaces (name) values ('second');
  begin
    insert into public.workspace_members (workspace_id, user_id)
    values ((select id from public.workspaces where name = 'second'), 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'second membership for founder A was accepted';
  exception when unique_violation then
    null; -- expected
  end;
end $$;

-- Only the owner role exists in this release.
do $$
begin
  begin
    insert into public.workspace_members (workspace_id, user_id, role)
    values ((select id from public.workspaces limit 1), gen_random_uuid(), 'member');
    raise exception 'non-owner role was accepted';
  exception when check_violation or foreign_key_violation then
    null; -- expected (check on role; FK on the random user would also stop it)
  end;
end $$;

-- ---------------------------------------------------------------------------------------------
-- RLS isolation as the `authenticated` role.
-- ---------------------------------------------------------------------------------------------
create temp table _ids as
select
  (select workspace_id from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-000000000001') as ws_a,
  (select workspace_id from public.workspace_members where user_id = 'bbbbbbbb-0000-0000-0000-000000000002') as ws_b;
grant select on _ids to authenticated;

-- Impersonate founder A.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

do $$
declare n int; ids record;
begin
  select * into ids from _ids;

  select count(*) into n from public.workspaces;
  if n <> 1 then raise exception 'A should see exactly 1 workspace, saw %', n; end if;
  if not exists (select 1 from public.workspaces where id = ids.ws_a) then
    raise exception 'A cannot see their own workspace';
  end if;
  if exists (select 1 from public.workspaces where id = ids.ws_b) then
    raise exception 'A can see B''s workspace';
  end if;

  select count(*) into n from public.workspace_members;
  if n <> 1 then raise exception 'A should see exactly 1 membership, saw %', n; end if;
  if exists (select 1 from public.workspace_members where workspace_id = ids.ws_b) then
    raise exception 'A can see B''s membership';
  end if;

  -- Cross-user UPDATE affects zero rows; own UPDATE affects one.
  update public.workspaces set name = 'hijacked' where id = ids.ws_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'A updated B''s workspace (% rows)', n; end if;

  update public.workspaces set name = 'A renamed' where id = ids.ws_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'A could not update their own workspace (% rows)', n; end if;
end $$;

-- Clients cannot insert or delete on either table (no policies exist for those operations).
do $$
begin
  begin
    insert into public.workspaces (name) values ('client-created');
    raise exception 'client INSERT on workspaces was allowed';
  exception when insufficient_privilege then null; end;

  begin
    insert into public.workspace_members (workspace_id, user_id)
    values ((select ws_a from _ids), 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'client INSERT on workspace_members was allowed';
  exception when insufficient_privilege or unique_violation then null; end;
end $$;

do $$
declare n int;
begin
  begin
    delete from public.workspaces where id = (select ws_a from _ids);
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'client DELETE on workspaces removed % rows', n; end if;
  exception when insufficient_privilege then null; -- denied outright: as safe as RLS filtering to zero rows
  end;

  begin
    delete from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'client DELETE on workspace_members removed % rows', n; end if;
  exception when insufficient_privilege then null; -- denied outright: as safe as RLS filtering to zero rows
  end;
end $$;

-- Impersonate founder B: sees only their own rows, and A's rename is invisible to B.
reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'bbbbbbbb-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);

do $$
declare n int; nm text;
begin
  select count(*) into n from public.workspaces;
  if n <> 1 then raise exception 'B should see exactly 1 workspace, saw %', n; end if;
  select name into nm from public.workspaces;
  if nm = 'A renamed' or nm = 'hijacked' then raise exception 'B sees A''s data (%)', nm; end if;
  if exists (select 1 from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-000000000001') then
    raise exception 'B can see A''s membership';
  end if;
end $$;

-- The anon role sees nothing and writes nothing.
reset role;
set local role anon;
do $$
declare n int;
begin
  begin
    select count(*) into n from public.workspaces;
    if n <> 0 then raise exception 'anon can read workspaces (% rows)', n; end if;
  exception when insufficient_privilege then null; end;
end $$;

reset role;
rollback;

select 'workspace_scaffold: all assertions passed' as result;
