-- S-05 rehearsal-session-turn-exchange: rehearsal sessions, their question/reply turns, and the hidden persona
-- scenario (FR-012, FR-013, FR-014).
--
-- Privacy rule (PRD NFR): the persona scenario must never reach a client. The scenario table therefore has
-- RLS enabled, NO policies, and no table privileges for `anon` or `authenticated`: only the service role
-- (the server) can read or write it. Founders can read their own sessions and turns, and write nothing:
-- every mutation goes through the service-only functions below, so the turn cap, ordering and auto-end rules
-- hold even if a founder calls the public API directly with their own session.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table public.rehearsal_sessions (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  assumption_id uuid not null references public.assumptions (id) on delete cascade,
  status        text not null default 'active' check (status in ('active', 'ended')),
  -- Widen this list (never narrow it) when a slice adds a reason, e.g. S-07's idle 'expired'.
  ended_reason  text check (ended_reason in ('user', 'cap')),
  created_at    timestamptz not null default now(),
  ended_at      timestamptz,
  check (
    (status = 'active' and ended_reason is null and ended_at is null)
    or (status = 'ended' and ended_reason is not null and ended_at is not null)
  )
);

-- At most one active session per project in this release.
create unique index rehearsal_sessions_one_active_per_project
  on public.rehearsal_sessions (project_id) where status = 'active';
create index rehearsal_sessions_project_created_idx
  on public.rehearsal_sessions (project_id, created_at desc);

create table public.rehearsal_turns (
  session_id uuid not null references public.rehearsal_sessions (id) on delete cascade,
  -- 1..8: the per-session cap of founder turns. The literal mirrors REHEARSAL_TURN_CAP in
  -- src/lib/services/rehearsal-persona.ts and the constant in rehearsal_store_reply below.
  seq        integer not null check (seq between 1 and 8),
  question   text not null check (char_length(question) between 1 and 500),
  reply      text check (reply is null or char_length(reply) between 1 and 2000),
  created_at timestamptz not null default now(),
  replied_at timestamptz,
  primary key (session_id, seq),
  check ((reply is null) = (replied_at is null))
);

-- The hidden persona. One row per session. No policies, no client privileges (see header).
create table public.rehearsal_scenarios (
  session_id uuid primary key references public.rehearsal_sessions (id) on delete cascade,
  scenario   jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.rehearsal_sessions enable row level security;
alter table public.rehearsal_turns enable row level security;
alter table public.rehearsal_scenarios enable row level security;

-- Privileges first (Supabase grants everything to anon/authenticated/service_role by default): founders get
-- SELECT on sessions and turns only, nothing on scenarios, and anon gets nothing at all.
revoke all on public.rehearsal_sessions, public.rehearsal_turns, public.rehearsal_scenarios from anon, authenticated;
grant select on public.rehearsal_sessions, public.rehearsal_turns to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Membership through the parent session (for the turns policy). Same shape as is_assumption_member.
-- ---------------------------------------------------------------------------------------------
create function public.is_rehearsal_session_member(session uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.rehearsal_sessions s
    join public.projects p on p.id = s.project_id
    join public.workspace_members m on m.workspace_id = p.workspace_id
    where s.id = session
      and m.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_rehearsal_session_member(uuid) from public, anon;
grant execute on function public.is_rehearsal_session_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- RLS: SELECT for the owning founder; no INSERT/UPDATE/DELETE policies; no policies at all on scenarios.
-- ---------------------------------------------------------------------------------------------
create policy "rehearsal_sessions_select_member" on public.rehearsal_sessions
  for select to authenticated
  using ((select public.is_project_member(project_id)));

create policy "rehearsal_turns_select_member" on public.rehearsal_turns
  for select to authenticated
  using ((select public.is_rehearsal_session_member(session_id)));

-- ---------------------------------------------------------------------------------------------
-- Service-only functions. The server proves ownership with the founder's RLS client first, then calls
-- these with the service role. SECURITY INVOKER (the service role bypasses RLS anyway), pinned search_path,
-- and EXECUTE revoked from every client role.
-- ---------------------------------------------------------------------------------------------

-- Creates a session and its hidden scenario together, or neither. Only an `active` assumption can be
-- rehearsed. A second active session on the project raises unique_violation (23505).
create function public.start_rehearsal_session(p_assumption uuid, p_scenario jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project uuid;
  v_status  text;
  v_session uuid;
begin
  select project_id, status into v_project, v_status from public.assumptions where id = p_assumption;
  if not found then
    raise exception 'assumption not found' using errcode = 'no_data_found';
  end if;
  if v_status <> 'active' then
    raise exception 'only an active assumption can be rehearsed' using errcode = 'check_violation';
  end if;

  insert into public.rehearsal_sessions (project_id, assumption_id)
  values (v_project, p_assumption)
  returning id into v_session;

  insert into public.rehearsal_scenarios (session_id, scenario) values (v_session, p_scenario);
  return v_session;
end;
$$;

-- Saves the founder's next question before any AI call. Everything is decided under a row lock on the
-- session, so two concurrent sends cannot both pass: the loser sees the winner's reply-less turn.
-- Returns {ok: true, seq} or {ok: false, code: not_found | not_active | reply_pending | cap_reached}.
create function public.rehearsal_add_turn(p_session uuid, p_question text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_cap     constant integer := 8;
  v_status  text;
  v_seq     integer;
  v_reply   text;
begin
  select status into v_status from public.rehearsal_sessions where id = p_session for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if v_status <> 'active' then return jsonb_build_object('ok', false, 'code', 'not_active'); end if;

  select seq, reply into v_seq, v_reply
  from public.rehearsal_turns where session_id = p_session order by seq desc limit 1;
  if found and v_reply is null then return jsonb_build_object('ok', false, 'code', 'reply_pending'); end if;

  v_seq := coalesce(v_seq, 0) + 1;
  if v_seq > c_cap then return jsonb_build_object('ok', false, 'code', 'cap_reached'); end if;

  insert into public.rehearsal_turns (session_id, seq, question) values (p_session, v_seq, p_question);
  return jsonb_build_object('ok', true, 'seq', v_seq);
end;
$$;

-- Attaches the persona's reply to a turn that has none, and ends the session in the same transaction when
-- the cap's last reply lands. A reply that arrives after the founder ended the session is still stored.
-- Returns {ok: true, stored: bool, ended: bool}; stored = false means the turn already had a reply.
create function public.rehearsal_store_reply(p_session uuid, p_seq integer, p_reply text)
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
  set reply = p_reply, replied_at = now()
  where session_id = p_session and seq = p_seq and reply is null;
  get diagnostics v_rows = row_count;

  if v_rows > 0 and p_seq >= c_cap and v_status = 'active' then
    update public.rehearsal_sessions
    set status = 'ended', ended_reason = 'cap', ended_at = now()
    where id = p_session;
    v_status := 'ended';
  end if;

  return jsonb_build_object('ok', true, 'stored', v_rows > 0, 'ended', v_status = 'ended');
end;
$$;

-- Ends an active session (idempotent: false when it was not active).
create function public.rehearsal_end_session(p_session uuid, p_reason text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.rehearsal_sessions
  set status = 'ended', ended_reason = p_reason, ended_at = now()
  where id = p_session and status = 'active';
  return found;
end;
$$;

revoke all on function public.start_rehearsal_session(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.rehearsal_add_turn(uuid, text) from public, anon, authenticated;
revoke all on function public.rehearsal_store_reply(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.rehearsal_end_session(uuid, text) from public, anon, authenticated;
grant execute on function public.start_rehearsal_session(uuid, jsonb) to service_role;
grant execute on function public.rehearsal_add_turn(uuid, text) to service_role;
grant execute on function public.rehearsal_store_reply(uuid, integer, text) to service_role;
grant execute on function public.rehearsal_end_session(uuid, text) to service_role;
