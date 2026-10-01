-- S-07 resumable-rehearsal-sessions (FR-017): a disrupted session (refresh, closed tab, dropped connection)
-- resumes without losing or duplicating a turn, up to 24 hours after the last activity.
--
-- Three primitives, all decided in the database (the DB clock, under row locks) so two parallel requests can
-- never disagree:
--   1. an idempotency key per question (`client_key`), so a re-sent question returns the saved turn instead of
--      adding a second one;
--   2. a short lease on the reply (`reply_started_at`), so a refresh during a slow request cannot start a second
--      generation, while an abandoned one (the lease went stale) can be resumed;
--   3. lazy idle expiry (`last_activity_at`): an active session untouched for 24 h is ended with reason
--      'expired', which also frees the project's single active-session slot. No scheduled job is needed.
--
-- Founders still have SELECT only on sessions and turns. Every write stays in service-role-only functions.

-- ---------------------------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------------------------
-- A default backfills any existing rows with a unique key; it is dropped so every future insert must supply one.
alter table public.rehearsal_turns add column client_key uuid not null default gen_random_uuid();
alter table public.rehearsal_turns alter column client_key drop default;
alter table public.rehearsal_turns add column reply_started_at timestamptz;

create unique index rehearsal_turns_client_key_uniq on public.rehearsal_turns (session_id, client_key);

alter table public.rehearsal_sessions add column last_activity_at timestamptz not null default now();

-- Widen (never narrow) the reason list; the status/ended consistency check stays as it is.
alter table public.rehearsal_sessions drop constraint rehearsal_sessions_ended_reason_check;
alter table public.rehearsal_sessions
  add constraint rehearsal_sessions_ended_reason_check check (ended_reason in ('user', 'cap', 'expired'));

-- ---------------------------------------------------------------------------------------------
-- Service-only functions. The 24 h idle window mirrors SESSION_IDLE_EXPIRY_MS and the 30 s reply lease mirrors
-- REPLY_LEASE_MS in src/lib/services/rehearsal-resume.ts.
-- ---------------------------------------------------------------------------------------------

-- Replaces the S-05 version (which took no key): the old function is dropped so no unkeyed write path remains.
drop function public.rehearsal_add_turn(uuid, text);

-- Saves the founder's next question before any AI call, decided under a row lock on the session.
-- A key already used in this session is a replay: it returns that turn (even if the session has since ended,
-- so a lost response to the 8th question still resolves) and changes nothing.
-- Returns {ok: true, seq, replay} or {ok: false, code: not_found | not_active | reply_pending | cap_reached}.
-- An active session idle for more than 24 h is expired here, so a stale session cannot take a new question.
create function public.rehearsal_add_turn(p_session uuid, p_question text, p_client_key uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_cap      constant integer := 8;
  c_idle     constant interval := interval '24 hours';
  v_status   text;
  v_last     timestamptz;
  v_seq      integer;
  v_reply    text;
  v_existing integer;
begin
  select status, last_activity_at into v_status, v_last
  from public.rehearsal_sessions where id = p_session for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;

  select seq into v_existing
  from public.rehearsal_turns where session_id = p_session and client_key = p_client_key;
  if found then return jsonb_build_object('ok', true, 'seq', v_existing, 'replay', true); end if;

  if v_status = 'active' and v_last < clock_timestamp() - c_idle then
    update public.rehearsal_sessions
    set status = 'ended', ended_reason = 'expired', ended_at = clock_timestamp()
    where id = p_session;
    v_status := 'ended';
  end if;
  if v_status <> 'active' then return jsonb_build_object('ok', false, 'code', 'not_active'); end if;

  select seq, reply into v_seq, v_reply
  from public.rehearsal_turns where session_id = p_session order by seq desc limit 1;
  if found and v_reply is null then return jsonb_build_object('ok', false, 'code', 'reply_pending'); end if;

  v_seq := coalesce(v_seq, 0) + 1;
  if v_seq > c_cap then return jsonb_build_object('ok', false, 'code', 'cap_reached'); end if;

  insert into public.rehearsal_turns (session_id, seq, question, client_key)
  values (p_session, v_seq, p_question, p_client_key);
  update public.rehearsal_sessions set last_activity_at = clock_timestamp() where id = p_session;
  return jsonb_build_object('ok', true, 'seq', v_seq, 'replay', false);
end;
$$;

-- Claims the right to generate one turn's reply. One conditional UPDATE, so two parallel callers cannot both
-- win: the row lock makes the second re-check the lease the first just set.
-- Returns 'claimed' | 'answered' | 'in_flight' (someone else holds a fresh lease) | 'not_found'.
create function public.rehearsal_claim_reply(p_session uuid, p_seq integer)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_lease constant interval := interval '30 seconds';
  v_rows  integer;
  v_reply text;
begin
  update public.rehearsal_turns
  set reply_started_at = clock_timestamp()
  where session_id = p_session and seq = p_seq and reply is null
    and (reply_started_at is null or reply_started_at < clock_timestamp() - c_lease);
  get diagnostics v_rows = row_count;
  if v_rows > 0 then return 'claimed'; end if;

  select reply into v_reply from public.rehearsal_turns where session_id = p_session and seq = p_seq;
  if not found then return 'not_found'; end if;
  if v_reply is not null then return 'answered'; end if;
  return 'in_flight';
end;
$$;

-- Gives the lease back after a failed generation so Retry works at once instead of after 30 s.
create function public.rehearsal_release_reply(p_session uuid, p_seq integer)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.rehearsal_turns set reply_started_at = null
  where session_id = p_session and seq = p_seq and reply is null;
$$;

-- Ends the project's active session if it has been idle for more than 24 h. Returns how many were ended (0 or 1).
create function public.rehearsal_expire_idle(p_project uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows integer;
begin
  update public.rehearsal_sessions
  set status = 'ended', ended_reason = 'expired', ended_at = clock_timestamp()
  where project_id = p_project and status = 'active'
    and last_activity_at < clock_timestamp() - interval '24 hours';
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Storing a reply now also clears the lease and counts as activity (a stored reply is the end of a request;
-- reads and polls never touch last_activity_at, or polling would keep a session alive forever).
create or replace function public.rehearsal_store_reply(p_session uuid, p_seq integer, p_reply text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_cap    constant integer := 8;
  v_status text;
  v_rows   integer;
begin
  select status into v_status from public.rehearsal_sessions where id = p_session for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;

  update public.rehearsal_turns
  set reply = p_reply, replied_at = now(), reply_started_at = null
  where session_id = p_session and seq = p_seq and reply is null;
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    update public.rehearsal_sessions set last_activity_at = clock_timestamp() where id = p_session;
  end if;

  if v_rows > 0 and p_seq >= c_cap and v_status = 'active' then
    update public.rehearsal_sessions
    set status = 'ended', ended_reason = 'cap', ended_at = now()
    where id = p_session;
    v_status := 'ended';
  end if;

  return jsonb_build_object('ok', true, 'stored', v_rows > 0, 'ended', v_status = 'ended');
end;
$$;

revoke all on function public.rehearsal_add_turn(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.rehearsal_claim_reply(uuid, integer) from public, anon, authenticated;
revoke all on function public.rehearsal_release_reply(uuid, integer) from public, anon, authenticated;
revoke all on function public.rehearsal_expire_idle(uuid) from public, anon, authenticated;
revoke all on function public.rehearsal_store_reply(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.rehearsal_add_turn(uuid, text, uuid) to service_role;
grant execute on function public.rehearsal_claim_reply(uuid, integer) to service_role;
grant execute on function public.rehearsal_release_reply(uuid, integer) to service_role;
grant execute on function public.rehearsal_expire_idle(uuid) to service_role;
grant execute on function public.rehearsal_store_reply(uuid, integer, text) to service_role;
