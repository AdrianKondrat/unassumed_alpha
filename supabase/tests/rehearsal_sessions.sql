-- Assertions for S-05 (rehearsal sessions, turns, hidden scenarios, service-only functions). Run against a reset local DB:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rehearsal_sessions.sql
begin;

insert into auth.users (id, email)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'founder-a@example.com'),
       ('bbbbbbbb-0000-0000-0000-000000000002', 'founder-b@example.com');

-- Fixtures written as the table owner. Founder A: one project with two active assumptions and one pending.
-- Founder B: one project with one active assumption.
create temp table ids as
select
  gen_random_uuid() as project_a, gen_random_uuid() as project_b,
  gen_random_uuid() as asm_a1, gen_random_uuid() as asm_a2, gen_random_uuid() as asm_a_pending,
  gen_random_uuid() as asm_b,
  null::uuid as session_a, null::uuid as session_b;
grant select, update on ids to authenticated, anon, service_role;

insert into public.projects (id, workspace_id, brief)
select project_a, (select workspace_id from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
       'Founder A brief that is comfortably long enough.' from ids
union all
select project_b, (select workspace_id from public.workspace_members where user_id = 'bbbbbbbb-0000-0000-0000-000000000002'),
       'Founder B brief that is comfortably long enough.' from ids;

insert into public.assumptions (id, project_id, statement, status)
select asm_a1, project_a, 'A active one', 'active' from ids
union all select asm_a2, project_a, 'A active two', 'active' from ids
union all select asm_a_pending, project_a, 'A still pending', 'suggested' from ids
union all select asm_b, project_b, 'B active', 'active' from ids;

-- ---- Table constraints (as the owner, so only the schema is under test) --------------------------------
do $$
declare
  pa uuid := (select project_a from ids);
  a1 uuid := (select asm_a1 from ids);
  s  uuid;
begin
  -- Session status / reason / timestamp consistency.
  begin
    insert into public.rehearsal_sessions (project_id, assumption_id, status, ended_reason) values (pa, a1, 'active', 'user');
    raise exception 'an active session with an ended_reason was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.rehearsal_sessions (project_id, assumption_id, status, ended_at) values (pa, a1, 'active', now());
    raise exception 'an active session with ended_at was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.rehearsal_sessions (project_id, assumption_id, status) values (pa, a1, 'ended');
    raise exception 'an ended session without a reason was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.rehearsal_sessions (project_id, assumption_id, status, ended_reason) values (pa, a1, 'ended', 'user');
    raise exception 'an ended session without ended_at was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.rehearsal_sessions (project_id, assumption_id, status, ended_reason, ended_at) values (pa, a1, 'ended', 'bogus', now());
    raise exception 'an unknown ended_reason was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.rehearsal_sessions (project_id, assumption_id, status) values (pa, a1, 'paused');
    raise exception 'an unknown status was accepted';
  exception when check_violation then null; end;

  -- One active session per project; a new one is fine once the first has ended.
  insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1) returning id into s;
  begin
    insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1);
    raise exception 'a second active session on one project was accepted';
  exception when unique_violation then null; end;
  update public.rehearsal_sessions set status = 'ended', ended_reason = 'user', ended_at = now() where id = s;
  insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1);
  delete from public.rehearsal_sessions where project_id = pa;

  -- Turn bounds.
  insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1) returning id into s;
  insert into public.rehearsal_turns (session_id, seq, question) values (s, 1, 'First question');
  begin
    insert into public.rehearsal_turns (session_id, seq, question) values (s, 1, 'Duplicate seq');
    raise exception 'a duplicate seq was accepted';
  exception when unique_violation then null; end;
  begin
    insert into public.rehearsal_turns (session_id, seq, question) values (s, 9, 'Ninth question');
    raise exception 'seq 9 was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.rehearsal_turns (session_id, seq, question) values (s, 0, 'Zeroth question');
    raise exception 'seq 0 was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.rehearsal_turns (session_id, seq, question) values (s, 2, repeat('q', 501));
    raise exception 'an over-long question was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.rehearsal_turns (session_id, seq, question) values (s, 2, '');
    raise exception 'an empty question was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.rehearsal_turns (session_id, seq, question, reply) values (s, 2, 'Q', 'a reply without a timestamp');
    raise exception 'a reply without replied_at was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.rehearsal_turns (session_id, seq, question, reply, replied_at) values (s, 2, 'Q', repeat('r', 2001), now());
    raise exception 'an over-long reply was accepted';
  exception when check_violation then null; end;
  delete from public.rehearsal_sessions where project_id = pa;
end $$;

-- ---- Service role: the function surface and the full 8-turn flow ---------------------------------------
set local role service_role;

do $$
declare
  pa uuid := (select project_a from ids);
  a1 uuid := (select asm_a1 from ids);
  a2 uuid := (select asm_a2 from ids);
  ap uuid := (select asm_a_pending from ids);
  ab uuid := (select asm_b from ids);
  s uuid;
  r jsonb;
  n int;
  i int;
  st text;
  why text;
begin
  -- Start: only an active assumption; unknown ids are refused; one active session per project.
  begin
    perform public.start_rehearsal_session(ap, '{"who":"x"}'::jsonb);
    raise exception 'a pending assumption was rehearsable';
  exception when check_violation then null; end;
  begin
    perform public.start_rehearsal_session(gen_random_uuid(), '{"who":"x"}'::jsonb);
    raise exception 'an unknown assumption was rehearsable';
  exception when no_data_found then null; end;
  s := public.start_rehearsal_session(a1, '{"who":"a tester","pain":"hidden"}'::jsonb);
  update ids set session_a = s;
  select count(*) into n from public.rehearsal_scenarios where session_id = s and scenario ->> 'who' = 'a tester';
  if n <> 1 then raise exception 'the scenario was not stored with the session'; end if;
  select count(*) into n from public.rehearsal_sessions where project_id = pa and status = 'active';
  if n <> 1 then raise exception 'expected one active session'; end if;
  begin
    perform public.start_rehearsal_session(a2, '{"who":"y"}'::jsonb);
    raise exception 'a second active session was started';
  exception when unique_violation then null; end;
  -- A refused start leaves no orphan scenario behind.
  select count(*) into n from public.rehearsal_scenarios;
  if n <> 1 then raise exception 'a failed start left a scenario behind (% rows)', n; end if;

  -- Unknown session ids.
  r := public.rehearsal_add_turn(gen_random_uuid(), 'hello');
  if r ->> 'code' <> 'not_found' then raise exception 'unknown session add_turn: %', r; end if;
  r := public.rehearsal_store_reply(gen_random_uuid(), 1, 'hello');
  if r ->> 'code' <> 'not_found' then raise exception 'unknown session store_reply: %', r; end if;

  -- Turns 1..8: a new question is refused while the previous one has no reply.
  for i in 1..8 loop
    r := public.rehearsal_add_turn(s, 'Question ' || i);
    if (r ->> 'ok')::boolean is not true or (r ->> 'seq')::int <> i then raise exception 'turn % not added: %', i, r; end if;
    r := public.rehearsal_add_turn(s, 'Pushy question');
    if r ->> 'code' <> 'reply_pending' then raise exception 'turn % allowed a second question: %', i, r; end if;
    r := public.rehearsal_store_reply(s, i, 'Reply ' || i);
    if (r ->> 'stored')::boolean is not true then raise exception 'reply % not stored: %', i, r; end if;
    if i < 8 and (r ->> 'ended')::boolean then raise exception 'session ended early at %', i; end if;
    if i = 8 and (r ->> 'ended')::boolean is not true then raise exception 'session did not end at the cap: %', r; end if;
  end loop;
  select status, ended_reason into st, why from public.rehearsal_sessions where id = s;
  if st <> 'ended' or why <> 'cap' then raise exception 'cap did not end the session (%, %)', st, why; end if;
  select count(*) into n from public.rehearsal_turns where session_id = s;
  if n <> 8 then raise exception 'expected 8 turns, saw %', n; end if;
  r := public.rehearsal_add_turn(s, 'Ninth question');
  if r ->> 'code' <> 'not_active' then raise exception 'a question was accepted after the cap: %', r; end if;

  -- Storing a reply twice keeps the first one.
  r := public.rehearsal_store_reply(s, 3, 'A different reply');
  if (r ->> 'stored')::boolean then raise exception 'a stored reply was overwritten'; end if;
  if (select reply from public.rehearsal_turns where session_id = s and seq = 3) <> 'Reply 3' then
    raise exception 'the first reply was replaced';
  end if;

  -- cap_reached: an active session that somehow holds 8 answered turns still refuses a ninth.
  update public.rehearsal_sessions set status = 'active', ended_reason = null, ended_at = null where id = s;
  r := public.rehearsal_add_turn(s, 'Ninth question');
  if r ->> 'code' <> 'cap_reached' then raise exception 'cap_reached not reported: %', r; end if;
  update public.rehearsal_sessions set status = 'ended', ended_reason = 'cap', ended_at = now() where id = s;

  -- A new session can start once the first has ended (project A's other assumption).
  s := public.start_rehearsal_session(a2, '{"who":"second"}'::jsonb);

  -- Ending: idempotent, with a checked reason; a late reply is still stored without touching the status.
  r := public.rehearsal_add_turn(s, 'Early question');
  if (r ->> 'ok')::boolean is not true then raise exception 'could not add a turn to the new session'; end if;
  begin
    perform public.rehearsal_end_session(s, 'bogus');
    raise exception 'an unknown end reason was accepted';
  exception when check_violation then null; end;
  if not public.rehearsal_end_session(s, 'user') then raise exception 'ending an active session returned false'; end if;
  if public.rehearsal_end_session(s, 'user') then raise exception 'ending an ended session returned true'; end if;
  r := public.rehearsal_store_reply(s, 1, 'Late reply');
  if (r ->> 'stored')::boolean is not true or (r ->> 'ended')::boolean is not true then
    raise exception 'a late reply was not stored: %', r;
  end if;
  select ended_reason into why from public.rehearsal_sessions where id = s;
  if why <> 'user' then raise exception 'a late reply changed ended_reason to %', why; end if;

  -- The founder ends the session while the 8th reply is still in flight: the late reply is stored, but the
  -- recorded reason stays 'user' (it must not be rewritten to 'cap').
  s := public.start_rehearsal_session(a1, '{"who":"third"}'::jsonb);
  for i in 1..7 loop
    perform public.rehearsal_add_turn(s, 'Q' || i);
    perform public.rehearsal_store_reply(s, i, 'R' || i);
  end loop;
  perform public.rehearsal_add_turn(s, 'Q8');
  perform public.rehearsal_end_session(s, 'user');
  r := public.rehearsal_store_reply(s, 8, 'Late R8');
  if (r ->> 'stored')::boolean is not true then raise exception 'the late 8th reply was not stored: %', r; end if;
  select ended_reason into why from public.rehearsal_sessions where id = s;
  if why <> 'user' then raise exception 'a late 8th reply rewrote ended_reason to %', why; end if;

  -- Founder B gets a session of their own (different project: no clash with A).
  update ids set session_b = public.start_rehearsal_session(ab, '{"who":"b persona"}'::jsonb);
  perform public.rehearsal_add_turn((select session_b from ids), 'B question');

  -- The service role can read scenarios.
  select count(*) into n from public.rehearsal_scenarios;
  if n <> 4 then raise exception 'service role should see 4 scenarios, saw %', n; end if;
end $$;

-- ---- Founder A ------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

do $$
declare
  sb uuid := (select session_b from ids);
  sa uuid := (select session_a from ids);
  n int;
begin
  select count(*) into n from public.rehearsal_sessions;
  if n <> 3 then raise exception 'A should see their 3 sessions, saw %', n; end if;
  select count(*) into n from public.rehearsal_turns where session_id = sa;
  if n <> 8 then raise exception 'A should see their 8 turns, saw %', n; end if;
  select count(*) into n from public.rehearsal_sessions where id = sb;
  if n <> 0 then raise exception 'A can see B''s session'; end if;
  select count(*) into n from public.rehearsal_turns where session_id = sb;
  if n <> 0 then raise exception 'A can see B''s turns'; end if;

  -- The scenario is unreadable: no privilege (layer 1). Any attempt is an error, never data.
  begin
    perform 1 from public.rehearsal_scenarios;
    raise exception 'authenticated selected from rehearsal_scenarios';
  exception when insufficient_privilege then null; end;

  -- No client writes of any kind, on any of the three tables.
  begin
    insert into public.rehearsal_sessions (project_id, assumption_id)
    values ((select project_a from ids), (select asm_a1 from ids));
    raise exception 'authenticated inserted a session';
  exception when insufficient_privilege then null; end;
  begin
    update public.rehearsal_sessions set status = 'ended', ended_reason = 'user', ended_at = now();
    raise exception 'authenticated updated a session';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.rehearsal_sessions;
    raise exception 'authenticated deleted a session';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.rehearsal_turns (session_id, seq, question) values (sa, 1, 'forged');
    raise exception 'authenticated inserted a turn';
  exception when insufficient_privilege then null; end;
  begin
    update public.rehearsal_turns set reply = 'forged reply', replied_at = now();
    raise exception 'authenticated rewrote a reply';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.rehearsal_turns;
    raise exception 'authenticated deleted a turn';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.rehearsal_scenarios (session_id, scenario) values (sa, '{}'::jsonb);
    raise exception 'authenticated inserted a scenario';
  exception when insufficient_privilege then null; end;
  begin
    update public.rehearsal_scenarios set scenario = '{}'::jsonb;
    raise exception 'authenticated updated a scenario';
  exception when insufficient_privilege then null; end;

  -- The service-only functions are not callable by founders.
  begin
    perform public.start_rehearsal_session((select asm_a1 from ids), '{}'::jsonb);
    raise exception 'authenticated ran start_rehearsal_session';
  exception when insufficient_privilege then null; end;
  begin
    perform public.rehearsal_add_turn(sa, 'forged');
    raise exception 'authenticated ran rehearsal_add_turn';
  exception when insufficient_privilege then null; end;
  begin
    perform public.rehearsal_store_reply(sa, 1, 'forged');
    raise exception 'authenticated ran rehearsal_store_reply';
  exception when insufficient_privilege then null; end;
  begin
    perform public.rehearsal_end_session(sa, 'user');
    raise exception 'authenticated ran rehearsal_end_session';
  exception when insufficient_privilege then null; end;
end $$;

-- The EXECUTE grant itself (the function bodies would also fail on table privileges, but the grant is the
-- first wall): only the service role may run the four mutation functions.
reset role;
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.start_rehearsal_session(uuid, jsonb)',
    'public.rehearsal_add_turn(uuid, text)',
    'public.rehearsal_store_reply(uuid, integer, text)',
    'public.rehearsal_end_session(uuid, text)'
  ] loop
    if has_function_privilege('authenticated', fn, 'execute') then raise exception 'authenticated may execute %', fn; end if;
    if has_function_privilege('anon', fn, 'execute') then raise exception 'anon may execute %', fn; end if;
    if not has_function_privilege('service_role', fn, 'execute') then raise exception 'service_role cannot execute %', fn; end if;
  end loop;
end $$;

-- Layer 2 of the scenario protection, tested on its own: even if a client privilege were granted by mistake,
-- RLS with no policy still returns zero rows for the owner. (Rolled back with everything else.)
reset role;
grant select on public.rehearsal_scenarios to authenticated;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.rehearsal_scenarios;
  if n <> 0 then raise exception 'RLS let the owner read % scenarios', n; end if;
end $$;
reset role;
revoke select on public.rehearsal_scenarios from authenticated;

-- ---- Founder B: isolation --------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'bbbbbbbb-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.rehearsal_sessions;
  if n <> 1 then raise exception 'B should see only their session, saw %', n; end if;
  select count(*) into n from public.rehearsal_turns;
  if n <> 1 then raise exception 'B should see only their turn, saw %', n; end if;
  if public.is_rehearsal_session_member((select session_a from ids)) then
    raise exception 'B is a member of A''s session';
  end if;
  if not public.is_rehearsal_session_member((select session_b from ids)) then
    raise exception 'B is not a member of their own session';
  end if;
end $$;

-- ---- anon: nothing ----------------------------------------------------------------------------------------
reset role;
set local role anon;
do $$
begin
  begin perform 1 from public.rehearsal_sessions; raise exception 'anon read sessions';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.rehearsal_turns; raise exception 'anon read turns';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.rehearsal_scenarios; raise exception 'anon read scenarios';
  exception when insufficient_privilege then null; end;
  begin perform public.rehearsal_add_turn(gen_random_uuid(), 'x'); raise exception 'anon ran rehearsal_add_turn';
  exception when insufficient_privilege then null; end;
  begin perform public.rehearsal_end_session(gen_random_uuid(), 'user'); raise exception 'anon ran rehearsal_end_session';
  exception when insufficient_privilege then null; end;
  begin perform public.is_rehearsal_session_member(gen_random_uuid()); raise exception 'anon ran is_rehearsal_session_member';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
rollback;
select 'rehearsal_sessions: all assertions passed' as result;
