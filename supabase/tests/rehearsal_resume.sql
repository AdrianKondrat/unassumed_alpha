-- Assertions for S-07 (resumable rehearsal sessions): idempotency key, reply lease, lazy idle expiry. Run against a
-- reset local DB:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rehearsal_resume.sql
begin;

insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'founder-a@example.com');

create temp table ids as
select gen_random_uuid() as project_a, gen_random_uuid() as asm_a1;
grant select on ids to authenticated, anon, service_role;

insert into public.projects (id, workspace_id, brief)
select project_a, (select workspace_id from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
       'Founder A brief that is comfortably long enough.' from ids;
insert into public.assumptions (id, project_id, statement, status)
select asm_a1, project_a, 'A active one', 'active' from ids;

-- ---- Schema constraints ---------------------------------------------------------------------------------
do $$
declare
  pa uuid := (select project_a from ids);
  a1 uuid := (select asm_a1 from ids);
  s1 uuid;
  s2 uuid;
  k  uuid := gen_random_uuid();
begin
  insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1) returning id into s1;

  -- The key is required on every turn.
  begin
    insert into public.rehearsal_turns (session_id, seq, question) values (s1, 1, 'No key');
    raise exception 'a turn without a client_key was accepted';
  exception when not_null_violation then null; end;

  -- A key is unique within a session but may be reused in another one.
  insert into public.rehearsal_turns (session_id, seq, question, client_key) values (s1, 1, 'First', k);
  begin
    insert into public.rehearsal_turns (session_id, seq, question, client_key) values (s1, 2, 'Same key again', k);
    raise exception 'a duplicate (session, client_key) was accepted';
  exception when unique_violation then null; end;
  update public.rehearsal_sessions set status = 'ended', ended_reason = 'user', ended_at = now() where id = s1;
  insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1) returning id into s2;
  insert into public.rehearsal_turns (session_id, seq, question, client_key) values (s2, 1, 'Other session', k);

  -- 'expired' is a valid end reason only on an ended session; unknown reasons stay refused.
  update public.rehearsal_sessions set status = 'ended', ended_reason = 'expired', ended_at = now() where id = s2;
  begin
    insert into public.rehearsal_sessions (project_id, assumption_id, status, ended_reason) values (pa, a1, 'active', 'expired');
    raise exception 'an active session with ended_reason expired was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.rehearsal_sessions (project_id, assumption_id, status, ended_reason, ended_at) values (pa, a1, 'ended', 'idle', now());
    raise exception 'an unknown ended_reason was accepted';
  exception when check_violation then null; end;

  delete from public.rehearsal_sessions where project_id = pa;

  -- The unkeyed S-05 function is gone, so no write path skips the key.
  if to_regprocedure('public.rehearsal_add_turn(uuid, text)') is not null then
    raise exception 'the unkeyed rehearsal_add_turn still exists';
  end if;
end $$;

-- ---- Idempotent add_turn ---------------------------------------------------------------------------------
do $$
declare
  pa uuid := (select project_a from ids);
  a1 uuid := (select asm_a1 from ids);
  s  uuid;
  s3 uuid;
  k1 uuid := gen_random_uuid();
  k2 uuid := gen_random_uuid();
  r  jsonb;
  n  integer;
begin
  insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1) returning id into s;

  r := public.rehearsal_add_turn(s, 'Question one', k1);
  if r ->> 'ok' <> 'true' or (r ->> 'seq')::int <> 1 or (r ->> 'replay')::boolean then raise exception 'first send: %', r; end if;

  -- The same key again (a lost response, a double click, a refresh) returns the same turn and adds nothing.
  r := public.rehearsal_add_turn(s, 'Question one', k1);
  if r ->> 'ok' <> 'true' or (r ->> 'seq')::int <> 1 or not (r ->> 'replay')::boolean then raise exception 'replay while pending: %', r; end if;
  select count(*) into n from public.rehearsal_turns where session_id = s;
  if n <> 1 then raise exception 'a replay added a turn (% rows)', n; end if;

  -- A replay returns the saved question as it was, even if the resend carries other text.
  r := public.rehearsal_add_turn(s, 'Different wording', k1);
  if (r ->> 'seq')::int <> 1 then raise exception 'replay with other text: %', r; end if;
  if (select question from public.rehearsal_turns where session_id = s and seq = 1) <> 'Question one' then
    raise exception 'a replay rewrote the question';
  end if;

  -- A different key while the latest turn has no reply is still refused.
  r := public.rehearsal_add_turn(s, 'Question two', k2);
  if r ->> 'code' <> 'reply_pending' then raise exception 'second key while pending: %', r; end if;

  -- After the reply lands, the old key still resolves to the same turn and the new key gets the next seq.
  perform public.rehearsal_store_reply(s, 1, 'Reply one');
  r := public.rehearsal_add_turn(s, 'Question one', k1);
  if (r ->> 'seq')::int <> 1 or not (r ->> 'replay')::boolean then raise exception 'replay after reply: %', r; end if;
  r := public.rehearsal_add_turn(s, 'Question two', k2);
  if (r ->> 'seq')::int <> 2 or (r ->> 'replay')::boolean then raise exception 'second question: %', r; end if;

  -- Unknown session.
  r := public.rehearsal_add_turn(gen_random_uuid(), 'x', gen_random_uuid());
  if r ->> 'code' <> 'not_found' then raise exception 'unknown session: %', r; end if;

  -- A replay still resolves after the session has ended (a lost response to the 8th question), but a new key does not.
  perform public.rehearsal_store_reply(s, 2, 'Reply two');
  perform public.rehearsal_end_session(s, 'user');
  r := public.rehearsal_add_turn(s, 'Question two', k2);
  if (r ->> 'seq')::int <> 2 or not (r ->> 'replay')::boolean then raise exception 'replay after end: %', r; end if;
  r := public.rehearsal_add_turn(s, 'Late question', gen_random_uuid());
  if r ->> 'code' <> 'not_active' then raise exception 'new key after end: %', r; end if;

  -- Keys are scoped to their session: the same key in a later session is a brand-new question, not a replay.
  insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1) returning id into s3;
  r := public.rehearsal_add_turn(s3, 'Question one', k1);
  if r ->> 'ok' <> 'true' or (r ->> 'seq')::int <> 1 or (r ->> 'replay')::boolean then raise exception 'key reused across sessions: %', r; end if;

  delete from public.rehearsal_sessions where project_id = pa;
end $$;

-- ---- Reply lease -----------------------------------------------------------------------------------------
do $$
declare
  pa uuid := (select project_a from ids);
  a1 uuid := (select asm_a1 from ids);
  s  uuid;
  c  text;
begin
  insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1) returning id into s;
  perform public.rehearsal_add_turn(s, 'Q1', gen_random_uuid());

  if public.rehearsal_claim_reply(s, 1) <> 'claimed' then raise exception 'first claim was not granted'; end if;
  c := public.rehearsal_claim_reply(s, 1);
  if c <> 'in_flight' then raise exception 'a second claim inside the lease returned %', c; end if;

  -- Just inside the 30 s lease the holder keeps it; just past it, the claim is open again.
  update public.rehearsal_turns set reply_started_at = clock_timestamp() - interval '29 seconds' where session_id = s and seq = 1;
  c := public.rehearsal_claim_reply(s, 1);
  if c <> 'in_flight' then raise exception 'a claim at 29 s returned %', c; end if;
  update public.rehearsal_turns set reply_started_at = clock_timestamp() - interval '31 seconds' where session_id = s and seq = 1;
  c := public.rehearsal_claim_reply(s, 1);
  if c <> 'claimed' then raise exception 'a claim at 31 s returned %', c; end if;
  if (select reply_started_at from public.rehearsal_turns where session_id = s and seq = 1) < clock_timestamp() - interval '5 seconds' then
    raise exception 'a stale claim did not renew the lease';
  end if;

  -- Releasing after a failure opens the claim at once.
  perform public.rehearsal_release_reply(s, 1);
  if (select reply_started_at from public.rehearsal_turns where session_id = s and seq = 1) is not null then
    raise exception 'release left the lease set';
  end if;
  if public.rehearsal_claim_reply(s, 1) <> 'claimed' then raise exception 'claim after release was refused'; end if;

  -- Storing the reply clears the lease; an answered turn cannot be claimed or released into regeneration.
  perform public.rehearsal_store_reply(s, 1, 'Reply');
  if (select reply_started_at from public.rehearsal_turns where session_id = s and seq = 1) is not null then
    raise exception 'store_reply left the lease set';
  end if;
  c := public.rehearsal_claim_reply(s, 1);
  if c <> 'answered' then raise exception 'claim on an answered turn returned %', c; end if;
  perform public.rehearsal_release_reply(s, 1);
  if (select reply from public.rehearsal_turns where session_id = s and seq = 1) <> 'Reply' then
    raise exception 'release touched an answered turn';
  end if;

  c := public.rehearsal_claim_reply(s, 5);
  if c <> 'not_found' then raise exception 'claim on a missing turn returned %', c; end if;
  c := public.rehearsal_claim_reply(gen_random_uuid(), 1);
  if c <> 'not_found' then raise exception 'claim on a missing session returned %', c; end if;

  delete from public.rehearsal_sessions where project_id = pa;
end $$;

-- ---- Activity and lazy expiry -----------------------------------------------------------------------------
do $$
declare
  pa uuid := (select project_a from ids);
  a1 uuid := (select asm_a1 from ids);
  s  uuid;
  s2 uuid;
  r  jsonb;
  t  timestamptz;
  n  integer;
begin
  insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1) returning id into s;

  -- A question and a stored reply both count as activity.
  update public.rehearsal_sessions set last_activity_at = clock_timestamp() - interval '2 hours' where id = s;
  perform public.rehearsal_add_turn(s, 'Q1', gen_random_uuid());
  select last_activity_at into t from public.rehearsal_sessions where id = s;
  if t < clock_timestamp() - interval '1 minute' then raise exception 'a question did not count as activity'; end if;
  update public.rehearsal_sessions set last_activity_at = clock_timestamp() - interval '2 hours' where id = s;
  perform public.rehearsal_store_reply(s, 1, 'R1');
  select last_activity_at into t from public.rehearsal_sessions where id = s;
  if t < clock_timestamp() - interval '1 minute' then raise exception 'a reply did not count as activity'; end if;
  -- Claims, releases and replays are not activity (polling must not keep a session alive).
  update public.rehearsal_sessions set last_activity_at = clock_timestamp() - interval '2 hours' where id = s;
  perform public.rehearsal_claim_reply(s, 1);
  perform public.rehearsal_release_reply(s, 1);
  perform public.rehearsal_expire_idle(pa);
  select last_activity_at into t from public.rehearsal_sessions where id = s;
  if t > clock_timestamp() - interval '1 hour' then raise exception 'claim/release/expire counted as activity'; end if;

  -- 23 h 59 m idle: still active everywhere. 24 h 1 m idle: expired.
  update public.rehearsal_sessions set last_activity_at = clock_timestamp() - interval '23 hours 59 minutes' where id = s;
  n := public.rehearsal_expire_idle(pa);
  if n <> 0 or (select status from public.rehearsal_sessions where id = s) <> 'active' then raise exception 'expired a session at 23h59m'; end if;
  r := public.rehearsal_add_turn(s, 'Q2', gen_random_uuid());
  if r ->> 'ok' <> 'true' then raise exception 'a question at 23h59m was refused: %', r; end if;
  perform public.rehearsal_store_reply(s, 2, 'R2');

  update public.rehearsal_sessions set last_activity_at = clock_timestamp() - interval '24 hours 1 minute' where id = s;
  r := public.rehearsal_add_turn(s, 'Q3', gen_random_uuid());
  if r ->> 'code' <> 'not_active' then raise exception 'a question at 24h01m was accepted: %', r; end if;
  if (select status || '/' || ended_reason from public.rehearsal_sessions where id = s) <> 'ended/expired' then
    raise exception 'add_turn did not record the expiry';
  end if;
  if (select ended_at from public.rehearsal_sessions where id = s) is null then raise exception 'expiry left ended_at null'; end if;
  -- The transcript survives expiry.
  select count(*) into n from public.rehearsal_turns where session_id = s;
  if n <> 2 then raise exception 'expiry changed the transcript (% turns)', n; end if;

  -- The slot is free again, and expire_idle ends only stale ACTIVE sessions (other end reasons stay as they were).
  insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1) returning id into s2;
  update public.rehearsal_sessions set last_activity_at = clock_timestamp() - interval '25 hours' where id = s2;
  if public.rehearsal_expire_idle(pa) <> 1 then raise exception 'expire_idle did not end the stale session'; end if;
  if public.rehearsal_expire_idle(pa) <> 0 then raise exception 'expire_idle is not idempotent'; end if;
  update public.rehearsal_sessions set ended_reason = 'user' where id = s2;
  update public.rehearsal_sessions set last_activity_at = clock_timestamp() - interval '48 hours' where id = s2;
  perform public.rehearsal_expire_idle(pa);
  if (select ended_reason from public.rehearsal_sessions where id = s2) <> 'user' then raise exception 'expire_idle rewrote an ended reason'; end if;
  if public.rehearsal_expire_idle(gen_random_uuid()) <> 0 then raise exception 'expire_idle on an unknown project ended something'; end if;
  insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1);

  delete from public.rehearsal_sessions where project_id = pa;
end $$;

-- ---- Privileges ------------------------------------------------------------------------------------------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.rehearsal_add_turn(uuid, text, uuid)',
    'public.rehearsal_claim_reply(uuid, integer)',
    'public.rehearsal_release_reply(uuid, integer)',
    'public.rehearsal_expire_idle(uuid)',
    'public.rehearsal_store_reply(uuid, integer, text)'
  ] loop
    if has_function_privilege('authenticated', fn, 'execute') then raise exception 'authenticated may execute %', fn; end if;
    if has_function_privilege('anon', fn, 'execute') then raise exception 'anon may execute %', fn; end if;
    if not has_function_privilege('service_role', fn, 'execute') then raise exception 'service_role cannot execute %', fn; end if;
  end loop;
end $$;

-- A founder can read their own turns and sessions (the new columns included) but write none of them.
do $$
declare
  pa uuid := (select project_a from ids);
  a1 uuid := (select asm_a1 from ids);
  s  uuid;
begin
  insert into public.rehearsal_sessions (project_id, assumption_id) values (pa, a1) returning id into s;
  perform public.rehearsal_add_turn(s, 'Q1', gen_random_uuid());
  create temp table sid as select s as id;
  grant select on sid to authenticated;
end $$;

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
do $$
declare
  sa uuid := (select id from sid);
  k  uuid;
  t  timestamptz;
begin
  select client_key, reply_started_at into k from public.rehearsal_turns where session_id = sa;
  select last_activity_at into t from public.rehearsal_sessions where id = sa;
  if k is null or t is null then raise exception 'the owner cannot read the resume columns'; end if;
  begin
    update public.rehearsal_turns set reply_started_at = null where session_id = sa;
    raise exception 'authenticated cleared a reply lease';
  exception when insufficient_privilege then null; end;
  begin
    update public.rehearsal_turns set client_key = gen_random_uuid() where session_id = sa;
    raise exception 'authenticated rewrote a client_key';
  exception when insufficient_privilege then null; end;
  begin
    update public.rehearsal_sessions set last_activity_at = now() where id = sa;
    raise exception 'authenticated refreshed last_activity_at';
  exception when insufficient_privilege then null; end;
  begin
    perform public.rehearsal_add_turn(sa, 'forged', gen_random_uuid());
    raise exception 'authenticated ran rehearsal_add_turn';
  exception when insufficient_privilege then null; end;
  begin
    perform public.rehearsal_claim_reply(sa, 1);
    raise exception 'authenticated ran rehearsal_claim_reply';
  exception when insufficient_privilege then null; end;
  begin
    perform public.rehearsal_expire_idle((select project_a from ids));
    raise exception 'authenticated ran rehearsal_expire_idle';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
set local role anon;
do $$
begin
  begin perform public.rehearsal_claim_reply(gen_random_uuid(), 1); raise exception 'anon ran rehearsal_claim_reply';
  exception when insufficient_privilege then null; end;
  begin perform public.rehearsal_release_reply(gen_random_uuid(), 1); raise exception 'anon ran rehearsal_release_reply';
  exception when insufficient_privilege then null; end;
  begin perform public.rehearsal_expire_idle(gen_random_uuid()); raise exception 'anon ran rehearsal_expire_idle';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
rollback;
select 'rehearsal_resume: all assertions passed' as result;
