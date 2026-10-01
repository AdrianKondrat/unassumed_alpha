-- Assertions for S-03 (manual canvas editing with conflict safety): revision-checked writes, the update guard,
-- add_canvas_claim, tenant isolation. Run against a reset local DB:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/canvas_claims_editing.sql
begin;

insert into auth.users (id, email)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'founder-a@example.com'),
       ('bbbbbbbb-0000-0000-0000-000000000002', 'founder-b@example.com');

create temp table ids as
select gen_random_uuid() as project_a, gen_random_uuid() as project_b,
       gen_random_uuid() as claim_ai, gen_random_uuid() as claim_founder, gen_random_uuid() as claim_b;
grant select on ids to authenticated, anon;

insert into public.projects (id, workspace_id, brief)
select project_a, (select workspace_id from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
       'Founder A brief that is comfortably long enough.' from ids
union all
select project_b, (select workspace_id from public.workspace_members where user_id = 'bbbbbbbb-0000-0000-0000-000000000002'),
       'Founder B brief that is comfortably long enough.' from ids;

insert into public.canvas_claims (id, project_id, block, position, text, origin)
select claim_ai, project_a, 'value_propositions', 0, 'AI wrote this', 'ai_draft' from ids
union all select claim_founder, project_a, 'value_propositions', 1, 'Founder wrote this', 'founder' from ids
union all select claim_b, project_b, 'channels', 0, 'B claim', 'ai_draft' from ids;

-- ---- Founder A: revision-checked writes ------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

do $$
declare
  c   uuid := (select claim_ai from ids);
  cf  uuid := (select claim_founder from ids);
  n   integer;
  r   record;
begin
  -- A save from the revision the founder loaded is accepted: one row, revision +1, now founder-authored.
  update public.canvas_claims set text = 'Founder rewrote this' where id = c and revision = 1;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a revision-matched update affected % rows', n; end if;
  select revision, origin, text into r from public.canvas_claims where id = c;
  if r.revision <> 2 then raise exception 'revision is % after one edit', r.revision; end if;
  if r.origin <> 'founder' then raise exception 'an edited AI claim kept origin %', r.origin; end if;

  -- The same save again from the old revision (the race loser) affects nothing.
  update public.canvas_claims set text = 'Loser text' where id = c and revision = 1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a stale update affected % rows', n; end if;
  if (select text from public.canvas_claims where id = c) <> 'Founder rewrote this' then raise exception 'a stale update overwrote the saved text'; end if;

  -- Consecutive saves from the returned revision never conflict with themselves.
  update public.canvas_claims set text = 'Second edit' where id = c and revision = 2;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'the follow-up save from revision 2 affected % rows', n; end if;
  if (select revision from public.canvas_claims where id = c) <> 3 then raise exception 'revision is not 3 after two edits'; end if;

  -- A save that changes nothing is a no-op: no bump, origin kept.
  update public.canvas_claims set text = 'Founder wrote this' where id = cf and revision = 1;
  get diagnostics n = row_count;
  select revision, origin into r from public.canvas_claims where id = cf;
  if n <> 1 or r.revision <> 1 or r.origin <> 'founder' then raise exception 'an unchanged save moved the claim (rev %, origin %)', r.revision, r.origin; end if;

  -- The caller cannot choose the revision or the origin.
  update public.canvas_claims set text = 'Third edit', revision = 99, origin = 'ai_draft' where id = c and revision = 3;
  select revision, origin into r from public.canvas_claims where id = c;
  if r.revision <> 4 then raise exception 'a caller set revision to %', r.revision; end if;
  if r.origin <> 'founder' then raise exception 'a caller set origin to %', r.origin; end if;
  update public.canvas_claims set origin = 'ai_draft' where id = cf;
  if (select origin from public.canvas_claims where id = cf) <> 'founder' then raise exception 'origin flipped without a text change'; end if;
  update public.canvas_claims set revision = 50 where id = cf;
  if (select revision from public.canvas_claims where id = cf) <> 1 then raise exception 'revision changed without a text change'; end if;

  -- Text bounds still hold on update.
  begin
    update public.canvas_claims set text = '' where id = c;
    raise exception 'an empty claim was accepted';
  exception when check_violation then null; end;
  begin
    update public.canvas_claims set text = repeat('x', 281) where id = c;
    raise exception 'an over-long claim was accepted';
  exception when check_violation then null; end;

  -- A claim never moves or changes owner.
  begin
    update public.canvas_claims set block = 'channels' where id = c;
    raise exception 'a claim changed block';
  exception when check_violation then null; end;
  begin
    update public.canvas_claims set position = 7 where id = c;
    raise exception 'a claim changed position';
  exception when check_violation then null; end;
  begin
    update public.canvas_claims set project_id = (select project_b from ids) where id = c;
    raise exception 'a claim moved to another project';
  exception when check_violation then null; when insufficient_privilege then null; end;
  begin
    update public.canvas_claims set created_at = now() - interval '1 year' where id = c;
    raise exception 'created_at was rewritten';
  exception when check_violation then null; end;
end $$;

-- ---- Delete: revision-checked ----------------------------------------------------------------------------
do $$
declare
  cf uuid := (select claim_founder from ids);
  c  uuid := (select claim_ai from ids);
  n  integer;
begin
  delete from public.canvas_claims where id = c and revision = 1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a stale delete affected % rows', n; end if;
  delete from public.canvas_claims where id = c and revision = 4;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a current delete affected % rows', n; end if;
  delete from public.canvas_claims where id = c and revision = 4;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'deleting a missing claim affected % rows', n; end if;
  -- cf stays for the isolation checks below.
  if not exists (select 1 from public.canvas_claims where id = cf) then raise exception 'the wrong claim was deleted'; end if;
end $$;

-- ---- add_canvas_claim ------------------------------------------------------------------------------------
do $$
declare
  pa uuid := (select project_a from ids);
  r  jsonb;
  n  integer;
  p  integer;
begin
  -- Next free position: the block holds positions 1 (cf) now, so the next claim lands on 2, then 3.
  r := public.add_canvas_claim(pa, 'value_propositions', 'First manual claim');
  if r ->> 'ok' <> 'true' or (r -> 'claim' ->> 'position')::int <> 2 then raise exception 'first add: %', r; end if;
  if r -> 'claim' ->> 'origin' <> 'founder' or (r -> 'claim' ->> 'revision')::int <> 1 then raise exception 'new claim defaults: %', r; end if;
  r := public.add_canvas_claim(pa, 'value_propositions', 'Second manual claim');
  if (r -> 'claim' ->> 'position')::int <> 3 then raise exception 'second add: %', r; end if;
  -- An empty block starts at 0.
  r := public.add_canvas_claim(pa, 'channels', 'A channel');
  if (r -> 'claim' ->> 'position')::int <> 0 then raise exception 'empty block: %', r; end if;
  -- Deleting a middle claim leaves a gap; the next position is still max + 1 (never reused, never colliding).
  delete from public.canvas_claims where project_id = pa and block = 'value_propositions' and position = 2;
  r := public.add_canvas_claim(pa, 'value_propositions', 'After a gap');
  if (r -> 'claim' ->> 'position')::int <> 4 then raise exception 'after a gap: %', r; end if;

  -- Per-block cap of 12.
  select count(*) into n from public.canvas_claims where project_id = pa and block = 'value_propositions';
  while n < 12 loop
    r := public.add_canvas_claim(pa, 'value_propositions', 'Filler ' || n);
    if r ->> 'ok' <> 'true' then raise exception 'filler % refused early: %', n, r; end if;
    n := n + 1;
  end loop;
  r := public.add_canvas_claim(pa, 'value_propositions', 'One too many');
  if r ->> 'ok' <> 'false' or r ->> 'code' <> 'block_full' then raise exception 'the 13th claim was not refused: %', r; end if;
  select count(*) into n from public.canvas_claims where project_id = pa and block = 'value_propositions';
  if n <> 12 then raise exception 'a refused add left % claims', n; end if;
  -- Another block is unaffected by the cap.
  r := public.add_canvas_claim(pa, 'channels', 'Another channel');
  if r ->> 'ok' <> 'true' then raise exception 'cap leaked across blocks: %', r; end if;

  -- Bounds and vocabulary still hold.
  begin perform public.add_canvas_claim(pa, 'channels', '');
    raise exception 'an empty claim was added';
  exception when check_violation then null; end;
  begin perform public.add_canvas_claim(pa, 'channels', repeat('x', 281));
    raise exception 'an over-long claim was added';
  exception when check_violation then null; end;
  begin perform public.add_canvas_claim(pa, 'not_a_block', 'x');
    raise exception 'an unknown block was added';
  exception when check_violation then null; end;

  -- Positions in a block are unique.
  select count(*) - count(distinct position) into p from public.canvas_claims where project_id = pa and block = 'value_propositions';
  if p <> 0 then raise exception 'duplicate positions in a block'; end if;

  -- Not into someone else's project.
  begin perform public.add_canvas_claim((select project_b from ids), 'channels', 'Intrusion');
    raise exception 'added a claim to another founder''s project';
  exception when insufficient_privilege then null; end;
  begin perform public.add_canvas_claim(gen_random_uuid(), 'channels', 'Ghost project');
    raise exception 'added a claim to a missing project';
  exception when insufficient_privilege then null; end;
end $$;

-- ---- Founder B: isolation --------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'bbbbbbbb-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
do $$
declare
  cf uuid := (select claim_founder from ids);
  n  integer;
begin
  update public.canvas_claims set text = 'B tampers' where id = cf;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'B updated A''s claim (% rows)', n; end if;
  delete from public.canvas_claims where id = cf;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'B deleted A''s claim (% rows)', n; end if;
  -- B can still edit their own claim.
  update public.canvas_claims set text = 'B edits' where id = (select claim_b from ids) and revision = 1;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'B cannot edit their own claim (% rows)', n; end if;
  select count(*) into n from public.canvas_claims where text = 'B tampers';
  if n <> 0 then raise exception 'B''s tamper text landed'; end if;
  begin perform public.add_canvas_claim((select project_a from ids), 'channels', 'B intrudes');
    raise exception 'B added to A''s project';
  exception when insufficient_privilege then null; end;
end $$;

-- ---- anon: nothing ---------------------------------------------------------------------------------------
reset role;
set local role anon;
do $$
begin
  begin perform public.add_canvas_claim((select project_a from ids), 'channels', 'anon');
    raise exception 'anon ran add_canvas_claim';
  exception when insufficient_privilege then null; end;
  begin update public.canvas_claims set text = 'anon';
    raise exception 'anon updated claims';
  exception when insufficient_privilege then null; end;
  begin delete from public.canvas_claims;
    raise exception 'anon deleted claims';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
do $$
begin
  if has_function_privilege('anon', 'public.add_canvas_claim(uuid, text, text)', 'execute') then raise exception 'anon may execute add_canvas_claim'; end if;
  if not has_function_privilege('authenticated', 'public.add_canvas_claim(uuid, text, text)', 'execute') then raise exception 'authenticated cannot execute add_canvas_claim'; end if;
end $$;

rollback;
select 'canvas_claims_editing: all assertions passed' as result;
