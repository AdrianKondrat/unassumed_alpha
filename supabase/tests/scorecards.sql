-- Assertions for S-06 (scorecards, flags, rewrites, claim/store functions). Run against a reset local DB:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/scorecards.sql
begin;

insert into auth.users (id, email)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'founder-a@example.com'),
       ('bbbbbbbb-0000-0000-0000-000000000002', 'founder-b@example.com');

-- Fixtures as the table owner. Founder A: three sessions on one project (one at a time active): s1 ended with
-- 3 turns, s2 ended with no turns, s3 active. Founder B: one ended session with one turn.
create temp table ids as
select
  gen_random_uuid() as project_a, gen_random_uuid() as project_b,
  gen_random_uuid() as asm_a, gen_random_uuid() as asm_b,
  gen_random_uuid() as s1, gen_random_uuid() as s2, gen_random_uuid() as s3, gen_random_uuid() as sb;
grant select on ids to authenticated, anon, service_role;

insert into public.projects (id, workspace_id, brief)
select project_a, (select workspace_id from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
       'Founder A brief that is comfortably long enough.' from ids
union all
select project_b, (select workspace_id from public.workspace_members where user_id = 'bbbbbbbb-0000-0000-0000-000000000002'),
       'Founder B brief that is comfortably long enough.' from ids;

insert into public.assumptions (id, project_id, statement, status)
select asm_a, project_a, 'A active', 'active' from ids
union all select asm_b, project_b, 'B active', 'active' from ids;

insert into public.rehearsal_sessions (id, project_id, assumption_id, status, ended_reason, ended_at)
select s1, project_a, asm_a, 'ended', 'user', now() from ids
union all select s2, project_a, asm_a, 'ended', 'user', now() from ids
union all select sb, project_b, asm_b, 'ended', 'cap', now() from ids;
insert into public.rehearsal_sessions (id, project_id, assumption_id) select s3, project_a, asm_a from ids;

insert into public.rehearsal_turns (session_id, client_key, seq, question, reply, replied_at)
select s1, gen_random_uuid(), 1, 'Don''t you think gardeners hate their tools?', 'Not really.', now() from ids
union all select s1, gen_random_uuid(), 2, E'Line one\nLine two with validated in it', 'Maybe.', now() from ids
union all select s1, gen_random_uuid(), 3, 'Tell me about the last time you bought a trowel.', null, null from ids
union all select sb, gen_random_uuid(), 1, 'B question', 'B reply', now() from ids;

-- ---- Table constraints (as the owner) ---------------------------------------------------------------------
do $$
declare
  s1 uuid := (select s1 from ids);
begin
  begin insert into public.scorecards (session_id, status) values (s1, 'bogus');
    raise exception 'an unknown status was accepted';
  exception when check_violation then null; end;
  begin insert into public.scorecards (session_id, status) values (s1, 'scoring');
    raise exception 'scoring without scoring_started_at was accepted';
  exception when check_violation then null; end;
  begin insert into public.scorecards (session_id, status, scoring_started_at) values (s1, 'ready', now());
    raise exception 'a non-scoring row with a lease timestamp was accepted';
  exception when check_violation then null; end;
  begin insert into public.scorecards (session_id, status) values (s1, 'ready');
    raise exception 'a ready scorecard without a summary was accepted';
  exception when check_violation then null; end;
  begin insert into public.scorecards (session_id, status) values (s1, 'failed');
    raise exception 'a failed scorecard without an error_kind was accepted';
  exception when check_violation then null; end;
  begin insert into public.scorecards (session_id, status, error_kind) values (s1, 'failed', 'rude');
    raise exception 'an unknown error_kind was accepted';
  exception when check_violation then null; end;
  begin insert into public.scorecards (session_id, status, summary, turns_scored, turns_flagged) values (s1, 'ready', 's', 2, 3);
    raise exception 'more flagged than scored turns was accepted';
  exception when check_violation then null; end;
  begin insert into public.scorecards (session_id, status, summary, turns_scored) values (s1, 'ready', 's', 9);
    raise exception 'turns_scored above the cap was accepted';
  exception when check_violation then null; end;
  begin insert into public.scorecards (session_id, status, summary) values (s1, 'ready', repeat('x', 501));
    raise exception 'an over-long summary was accepted';
  exception when check_violation then null; end;
  begin insert into public.scorecards (session_id, status, summary) values (gen_random_uuid(), 'ready', 's');
    raise exception 'a scorecard for an unknown session was accepted';
  exception when foreign_key_violation then null; end;

  -- One scorecard per session.
  insert into public.scorecards (session_id, status, summary) values (s1, 'ready', 'Summary');
  begin insert into public.scorecards (session_id, status, summary) values (s1, 'ready', 'Again');
    raise exception 'a second scorecard for one session was accepted';
  exception when unique_violation then null; end;

  -- Flags and rewrites must point at a real turn, with bounded text and a known label.
  begin insert into public.scorecard_flags (session_id, seq, label, quote, explanation) values (s1, 7, 'leading', 'q', 'e');
    raise exception 'a flag on a turn that does not exist was accepted';
  exception when foreign_key_violation then null; end;
  begin insert into public.scorecard_flags (session_id, seq, label, quote, explanation) values (s1, 1, 'rude', 'q', 'e');
    raise exception 'an unknown label was accepted';
  exception when check_violation then null; end;
  begin insert into public.scorecard_flags (session_id, seq, label, quote, explanation) values (s1, 1, 'leading', 'q', repeat('e', 301));
    raise exception 'an over-long explanation was accepted';
  exception when check_violation then null; end;
  insert into public.scorecard_flags (session_id, seq, label, quote, explanation) values (s1, 1, 'leading', 'q', 'e');
  begin insert into public.scorecard_flags (session_id, seq, label, quote, explanation) values (s1, 1, 'leading', 'q', 'again');
    raise exception 'a duplicate (turn, label) flag was accepted';
  exception when unique_violation then null; end;
  begin insert into public.scorecard_rewrites (session_id, seq, original, suggestion) values (s1, 9, 'o', 's');
    raise exception 'a rewrite on a turn that does not exist was accepted';
  exception when foreign_key_violation then null; end;
  begin insert into public.scorecard_rewrites (session_id, seq, original, suggestion) values (s1, 1, 'o', repeat('s', 301));
    raise exception 'an over-long rewrite was accepted';
  exception when check_violation then null; end;

  -- Cleanup of this scratch data so the function tests start from nothing.
  delete from public.scorecards;
end $$;

-- ---- Service role: claim and store ------------------------------------------------------------------------
set local role service_role;

do $$
declare
  s1 uuid := (select s1 from ids);
  s2 uuid := (select s2 from ids);
  s3 uuid := (select s3 from ids);
  r jsonb;
  c text;
  n int;
  q text;
begin
  -- Claiming.
  if public.claim_scorecard(gen_random_uuid()) <> 'not_found' then raise exception 'unknown session did not report not_found'; end if;
  if public.claim_scorecard(s3) <> 'not_ended' then raise exception 'an active session could be scored'; end if;
  select count(*) into n from public.scorecards where session_id = s3;
  if n <> 0 then raise exception 'a refused claim left a row behind'; end if;

  if public.claim_scorecard(s1) <> 'claimed' then raise exception 'first claim not granted'; end if;
  if public.claim_scorecard(s1) <> 'in_progress' then raise exception 'a fresh lease was claimed twice'; end if;
  select count(*) into n from public.scorecards where session_id = s1 and status = 'scoring' and scoring_started_at is not null;
  if n <> 1 then raise exception 'claim did not record a scoring row'; end if;

  -- A stale lease (older than 60 s) can be taken over.
  update public.scorecards set scoring_started_at = now() - interval '61 seconds' where session_id = s1;
  if public.claim_scorecard(s1) <> 'claimed' then raise exception 'a stale lease was not retaken'; end if;
  update public.scorecards set scoring_started_at = now() - interval '59 seconds' where session_id = s1;
  if public.claim_scorecard(s1) <> 'in_progress' then raise exception 'a 59 s old lease was retaken'; end if;
  update public.scorecards set scoring_started_at = now() where session_id = s1;

  -- Storing: validation first.
  begin
    perform public.store_scorecard(s1, 'bogus', null, null, null, '[]', '[]');
    raise exception 'an unknown store status was accepted';
  exception when check_violation then null; end;
  begin
    perform public.store_scorecard(s1, 'ready', 'Summary', 'm', null, '[]', '[]');
    raise exception 'a ready scorecard with no rewrites was stored';
  exception when check_violation then null; end;
  begin
    perform public.store_scorecard(s1, 'ready', null, 'm', null, '[]', '[{"seq":1,"suggestion":"Better."}]');
    raise exception 'a ready scorecard with no summary was stored';
  exception when check_violation then null; end;
  begin
    perform public.store_scorecard(s1, 'ready', 'Summary', 'm', null,
      '[{"seq":9,"label":"leading","explanation":"e"}]', '[{"seq":1,"suggestion":"Better."}]');
    raise exception 'a flag on a missing turn was stored';
  exception when not_null_violation then null; end;
  begin
    perform public.store_scorecard(s1, 'ready', 'Summary', 'm', null,
      '[{"seq":1,"label":"rude","explanation":"e"}]', '[{"seq":1,"suggestion":"Better."}]');
    raise exception 'an unknown label was stored';
  exception when check_violation then null; end;
  begin
    perform public.store_scorecard(s1, 'ready', 'Summary', 'm', null, '[]', '[{"seq":9,"suggestion":"Better."}]');
    raise exception 'a rewrite on a missing turn was stored';
  exception when not_null_violation then null; end;
  -- Every refused store left the claimed state untouched (all-or-nothing).
  select status into c from public.scorecards where session_id = s1;
  if c <> 'scoring' then raise exception 'a refused store changed the status to %', c; end if;
  select count(*) into n from public.scorecard_flags where session_id = s1;
  if n <> 0 then raise exception 'a refused store left % flags behind', n; end if;

  -- A good store: quotes come from the turns, not the caller.
  r := public.store_scorecard(s1, 'ready', 'You asked one strong question.', 'test-model', null,
    '[{"seq":1,"label":"leading","explanation":"Invites agreement.","quote":"FORGED"},
      {"seq":1,"label":"specificity","explanation":"Broad."},
      {"seq":2,"label":"solution_biased","explanation":"Pitches."}]',
    '[{"seq":3,"suggestion":"What did you do last time?","original":"FORGED"}]');
  if (r ->> 'ok')::boolean is not true then raise exception 'good store refused: %', r; end if;
  select quote into q from public.scorecard_flags where session_id = s1 and seq = 1 and label = 'leading';
  if q <> 'Don''t you think gardeners hate their tools?' then raise exception 'flag quote is not the stored question: %', q; end if;
  select quote into q from public.scorecard_flags where session_id = s1 and seq = 2 limit 1;
  if q <> E'Line one\nLine two with validated in it' then raise exception 'a multi-line quote was not exact: %', q; end if;
  select original into q from public.scorecard_rewrites where session_id = s1 and seq = 3;
  if q <> 'Tell me about the last time you bought a trowel.' then raise exception 'rewrite original is not the stored question: %', q; end if;
  select count(*) into n from public.scorecards
   where session_id = s1 and status = 'ready' and summary is not null and model = 'test-model'
     and turns_scored = 3 and turns_flagged = 2 and scoring_started_at is null and error_kind is null;
  if n <> 1 then raise exception 'scorecard row not finalised as expected'; end if;
  select count(*) into n from public.scorecard_flags where session_id = s1;
  if n <> 3 then raise exception 'expected 3 flags, saw %', n; end if;

  -- Finished scorecards are not re-scored and cannot be overwritten by a late writer.
  if public.claim_scorecard(s1) <> 'ready' then raise exception 'a ready scorecard was claimed again'; end if;
  r := public.store_scorecard(s1, 'failed', null, null, 'timeout', '[]', '[]');
  if r ->> 'code' <> 'not_scoring' then raise exception 'a late writer overwrote a ready scorecard: %', r; end if;
  select count(*) into n from public.scorecard_flags where session_id = s1;
  if n <> 3 then raise exception 'a refused late store deleted flags'; end if;
  r := public.store_scorecard(s3, 'failed', null, null, 'timeout', '[]', '[]');
  if r ->> 'code' <> 'not_scoring' then raise exception 'a store without a claim was accepted: %', r; end if;
  r := public.store_scorecard(gen_random_uuid(), 'failed', null, null, 'timeout', '[]', '[]');
  if r ->> 'code' <> 'not_found' then raise exception 'unknown session store: %', r; end if;

  -- Insufficient: a session with no turns.
  if public.claim_scorecard(s2) <> 'claimed' then raise exception 's2 claim failed'; end if;
  r := public.store_scorecard(s2, 'insufficient', null, null, null, '[]', '[]');
  if (r ->> 'ok')::boolean is not true then raise exception 'insufficient store refused: %', r; end if;
  select count(*) into n from public.scorecards where session_id = s2 and status = 'insufficient' and turns_scored = 0 and summary is null;
  if n <> 1 then raise exception 'insufficient scorecard not as expected'; end if;
  if public.claim_scorecard(s2) <> 'insufficient' then raise exception 'an insufficient scorecard was claimed again'; end if;
end $$;

-- A failed attempt can be retried, and a good retry replaces the failed row cleanly. Start from nothing for s1.
reset role;
delete from public.scorecards where session_id = (select s1 from ids);
set local role service_role;

do $$
declare
  s1 uuid := (select s1 from ids);
  r jsonb;
  n int;
begin
  if public.claim_scorecard(s1) <> 'claimed' then raise exception 'claim after reset failed'; end if;
  r := public.store_scorecard(s1, 'failed', 'ignored summary', 'm', 'invalid_output', '[{"seq":1,"label":"leading","explanation":"x"}]', '[{"seq":1,"suggestion":"y"}]');
  if (r ->> 'ok')::boolean is not true then raise exception 'failed store refused: %', r; end if;
  select count(*) into n from public.scorecards where session_id = s1 and status = 'failed' and error_kind = 'invalid_output' and summary is null and turns_scored = 0;
  if n <> 1 then raise exception 'failed scorecard not as expected'; end if;
  select count(*) into n from public.scorecard_flags where session_id = s1;
  if n <> 0 then raise exception 'a failed scorecard kept flags'; end if;

  if public.claim_scorecard(s1) <> 'claimed' then raise exception 'a failed scorecard could not be retried'; end if;
  select count(*) into n from public.scorecards where session_id = s1 and status = 'scoring' and error_kind is null;
  if n <> 1 then raise exception 'retry claim did not clear the error'; end if;
  -- Stale rows (however they got there) never survive a new result: the store replaces flags and rewrites.
  insert into public.scorecard_flags (session_id, seq, label, quote, explanation) values (s1, 1, 'specificity', 'q', 'stale flag');
  insert into public.scorecard_rewrites (session_id, seq, original, suggestion) values (s1, 1, 'o', 'stale rewrite');
  r := public.store_scorecard(s1, 'ready', 'Second try worked.', 'm', null, '[]', '[{"seq":3,"suggestion":"Walk me through that."}]');
  select count(*) into n from public.scorecard_flags where session_id = s1;
  if n <> 0 then raise exception 'a stale flag survived a new result'; end if;
  select count(*) into n from public.scorecard_rewrites where session_id = s1 and suggestion = 'stale rewrite';
  if n <> 0 then raise exception 'a stale rewrite survived a new result'; end if;
  if (r ->> 'ok')::boolean is not true then raise exception 'retry store refused: %', r; end if;
  select count(*) into n from public.scorecards where session_id = s1 and status = 'ready' and turns_flagged = 0 and turns_scored = 3;
  if n <> 1 then raise exception 'ready-without-flags scorecard not as expected'; end if;
end $$;

-- Re-seed a ready scorecard with flags for the isolation checks.
reset role;
delete from public.scorecards where session_id = (select s1 from ids);
set local role service_role;
do $$
declare s1 uuid := (select s1 from ids); sb uuid := (select sb from ids);
begin
  perform public.claim_scorecard(s1);
  perform public.store_scorecard(s1, 'ready', 'Summary A', 'm', null,
    '[{"seq":1,"label":"leading","explanation":"Invites agreement."}]', '[{"seq":1,"suggestion":"What happened last time?"}]');
  perform public.claim_scorecard(sb);
  perform public.store_scorecard(sb, 'ready', 'Summary B', 'm', null,
    '[{"seq":1,"label":"hypothetical","explanation":"Future."}]', '[{"seq":1,"suggestion":"What did you do last time?"}]');
end $$;

-- ---- The EXECUTE grants themselves --------------------------------------------------------------------------
reset role;
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.claim_scorecard(uuid)',
    'public.store_scorecard(uuid, text, text, text, text, jsonb, jsonb)'
  ] loop
    if has_function_privilege('authenticated', fn, 'execute') then raise exception 'authenticated may execute %', fn; end if;
    if has_function_privilege('anon', fn, 'execute') then raise exception 'anon may execute %', fn; end if;
    if not has_function_privilege('service_role', fn, 'execute') then raise exception 'service_role cannot execute %', fn; end if;
  end loop;
end $$;

-- ---- Founder A ----------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

do $$
declare
  s1 uuid := (select s1 from ids);
  sb uuid := (select sb from ids);
  n int;
begin
  select count(*) into n from public.scorecards;
  if n <> 2 then raise exception 'A should see their 2 scorecards (ready + insufficient), saw %', n; end if;
  select count(*) into n from public.scorecard_flags;
  if n <> 1 then raise exception 'A should see their 1 flag, saw %', n; end if;
  select count(*) into n from public.scorecard_rewrites;
  if n <> 1 then raise exception 'A should see their 1 rewrite, saw %', n; end if;
  select count(*) into n from public.scorecards where session_id = sb;
  if n <> 0 then raise exception 'A can see B''s scorecard'; end if;

  -- No client writes of any kind.
  begin insert into public.scorecards (session_id, status, summary) values ((select s2 from ids), 'ready', 'forged');
    raise exception 'authenticated inserted a scorecard';
  exception when insufficient_privilege then null; end;
  begin update public.scorecards set summary = 'rewritten';
    raise exception 'authenticated updated a scorecard';
  exception when insufficient_privilege then null; end;
  begin delete from public.scorecards;
    raise exception 'authenticated deleted a scorecard';
  exception when insufficient_privilege then null; end;
  begin insert into public.scorecard_flags (session_id, seq, label, quote, explanation) values (s1, 2, 'leading', 'q', 'e');
    raise exception 'authenticated inserted a flag';
  exception when insufficient_privilege then null; end;
  begin update public.scorecard_flags set explanation = 'rewritten';
    raise exception 'authenticated updated a flag';
  exception when insufficient_privilege then null; end;
  begin delete from public.scorecard_flags;
    raise exception 'authenticated deleted a flag';
  exception when insufficient_privilege then null; end;
  begin insert into public.scorecard_rewrites (session_id, seq, original, suggestion) values (s1, 2, 'o', 's');
    raise exception 'authenticated inserted a rewrite';
  exception when insufficient_privilege then null; end;
  begin update public.scorecard_rewrites set suggestion = 'rewritten';
    raise exception 'authenticated updated a rewrite';
  exception when insufficient_privilege then null; end;
  begin delete from public.scorecard_rewrites;
    raise exception 'authenticated deleted a rewrite';
  exception when insufficient_privilege then null; end;
  begin perform public.claim_scorecard(s1);
    raise exception 'authenticated ran claim_scorecard';
  exception when insufficient_privilege then null; end;
  begin perform public.store_scorecard(s1, 'failed', null, null, 'timeout', '[]', '[]');
    raise exception 'authenticated ran store_scorecard';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'bbbbbbbb-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);

-- ---- Founder B: isolation ---------------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from public.scorecards;
  if n <> 1 then raise exception 'B should see only their scorecard, saw %', n; end if;
  select count(*) into n from public.scorecard_flags;
  if n <> 1 then raise exception 'B should see only their flag, saw %', n; end if;
  select count(*) into n from public.scorecard_rewrites;
  if n <> 1 then raise exception 'B should see only their rewrite, saw %', n; end if;
  if (select summary from public.scorecards) <> 'Summary B' then raise exception 'B sees someone else''s scorecard'; end if;
end $$;

-- ---- anon: nothing --------------------------------------------------------------------------------------------
reset role;
set local role anon;
do $$
begin
  begin perform 1 from public.scorecards; raise exception 'anon read scorecards';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.scorecard_flags; raise exception 'anon read flags';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.scorecard_rewrites; raise exception 'anon read rewrites';
  exception when insufficient_privilege then null; end;
  begin perform public.claim_scorecard(gen_random_uuid()); raise exception 'anon ran claim_scorecard';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
rollback;
select 'scorecards: all assertions passed' as result;
