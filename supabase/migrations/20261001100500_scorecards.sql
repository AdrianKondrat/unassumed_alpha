-- S-06 rehearsal-scorecard: the question-quality scorecard for an ended rehearsal session (FR-015, FR-016).
--
-- A scorecard scores the FOUNDER'S QUESTIONS, never the idea. Everything is written by the server through
-- service-role-only functions (founders get SELECT only, like the rehearsal tables), and the database, not
-- just the app, guarantees the rules that matter:
--   * one scorecard per session (primary key), and only for an ended session;
--   * a flag's `quote` and a rewrite's `original` are copied from the stored turn inside the function, so a
--     quote is exact even if app code regresses (the model only ever supplies positions and prose);
--   * a `ready` scorecard carries at least one rewrite;
--   * a lease (`scoring`, stale after 60 s, database clock) so double-clicks and parallel tabs cost one AI call.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table public.scorecards (
  -- One scorecard per session.
  session_id         uuid primary key references public.rehearsal_sessions (id) on delete cascade,
  status             text not null check (status in ('scoring', 'ready', 'failed', 'insufficient')),
  summary            text check (summary is null or char_length(summary) between 1 and 500),
  model              text,
  error_kind         text check (error_kind is null or error_kind in ('timeout', 'ai_failed', 'invalid_output', 'server_error')),
  -- Counts of founder questions scored and of those with at least one flag (kept for a later trend view).
  turns_scored       integer not null default 0 check (turns_scored between 0 and 8),
  turns_flagged      integer not null default 0 check (turns_flagged between 0 and 8),
  -- Set exactly while status = 'scoring'.
  scoring_started_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (turns_flagged <= turns_scored),
  check ((status = 'scoring') = (scoring_started_at is not null)),
  check (status <> 'ready' or summary is not null),
  check (status <> 'failed' or error_kind is not null)
);

create table public.scorecard_flags (
  session_id  uuid not null references public.scorecards (session_id) on delete cascade,
  seq         integer not null,
  label       text not null check (label in ('leading', 'hypothetical', 'solution_biased', 'past_behavior', 'specificity')),
  -- Exact founder text, copied from rehearsal_turns by store_scorecard.
  quote       text not null check (char_length(quote) between 1 and 500),
  explanation text not null check (char_length(explanation) between 1 and 300),
  primary key (session_id, seq, label),
  foreign key (session_id, seq) references public.rehearsal_turns (session_id, seq) on delete cascade
);

create table public.scorecard_rewrites (
  session_id uuid not null references public.scorecards (session_id) on delete cascade,
  seq        integer not null,
  original   text not null check (char_length(original) between 1 and 500),
  suggestion text not null check (char_length(suggestion) between 1 and 300),
  primary key (session_id, seq),
  foreign key (session_id, seq) references public.rehearsal_turns (session_id, seq) on delete cascade
);

alter table public.scorecards enable row level security;
alter table public.scorecard_flags enable row level security;
alter table public.scorecard_rewrites enable row level security;

-- Founders read their own scorecards and nothing else: no write privileges at all, and none for anon.
revoke all on public.scorecards, public.scorecard_flags, public.scorecard_rewrites from anon, authenticated;
grant select on public.scorecards, public.scorecard_flags, public.scorecard_rewrites to authenticated;

create policy "scorecards_select_member" on public.scorecards
  for select to authenticated
  using ((select public.is_rehearsal_session_member(session_id)));

create policy "scorecard_flags_select_member" on public.scorecard_flags
  for select to authenticated
  using ((select public.is_rehearsal_session_member(session_id)));

create policy "scorecard_rewrites_select_member" on public.scorecard_rewrites
  for select to authenticated
  using ((select public.is_rehearsal_session_member(session_id)));

-- ---------------------------------------------------------------------------------------------
-- Service-only functions (EXECUTE revoked from every client role below).
-- ---------------------------------------------------------------------------------------------

-- Takes the scoring lease for an ended session, under a row lock on the session. Returns:
--   not_found | not_ended   the session is unknown / still active
--   ready | insufficient    already scored: nothing to do
--   in_progress             another request holds a fresh lease (< 60 s old)
--   claimed                 this caller must now score (first time, a failed earlier try, or a stale lease)
create function public.claim_scorecard(p_session uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session_status text;
  v_status         text;
  v_started        timestamptz;
begin
  select status into v_session_status from public.rehearsal_sessions where id = p_session for update;
  if not found then return 'not_found'; end if;
  if v_session_status <> 'ended' then return 'not_ended'; end if;

  select status, scoring_started_at into v_status, v_started from public.scorecards where session_id = p_session;
  if found then
    if v_status in ('ready', 'insufficient') then return v_status; end if;
    if v_status = 'scoring' and v_started > now() - interval '60 seconds' then return 'in_progress'; end if;
    update public.scorecards
    set status = 'scoring', scoring_started_at = now(), error_kind = null, updated_at = now()
    where session_id = p_session;
    return 'claimed';
  end if;

  insert into public.scorecards (session_id, status, scoring_started_at) values (p_session, 'scoring', now());
  return 'claimed';
end;
$$;

-- Finishes a claimed scoring attempt, replacing any earlier flags and rewrites atomically.
--   p_status  ready | failed | insufficient
--   p_flags   [{ "seq": int, "label": text, "explanation": text }, ...]   (no quote: it is copied from the turn)
--   p_rewrites [{ "seq": int, "suggestion": text }, ...]                  (the original is copied from the turn)
-- Returns {ok: true} or {ok: false, code: not_found | not_scoring}. Anything else invalid raises and rolls back.
create function public.store_scorecard(
  p_session    uuid,
  p_status     text,
  p_summary    text,
  p_model      text,
  p_error_kind text,
  p_flags      jsonb,
  p_rewrites   jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current text;
  v_scored  integer;
  v_flagged integer;
begin
  if p_status not in ('ready', 'failed', 'insufficient') then
    raise exception 'invalid scorecard status' using errcode = 'check_violation';
  end if;

  perform 1 from public.rehearsal_sessions where id = p_session for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;

  select status into v_current from public.scorecards where session_id = p_session;
  -- Only a claimed attempt may store: a late writer cannot overwrite a finished scorecard.
  if not found or v_current <> 'scoring' then return jsonb_build_object('ok', false, 'code', 'not_scoring'); end if;

  delete from public.scorecard_flags where session_id = p_session;
  delete from public.scorecard_rewrites where session_id = p_session;

  if p_status = 'ready' then
    if p_summary is null then raise exception 'a ready scorecard needs a summary' using errcode = 'check_violation'; end if;
    if coalesce(jsonb_array_length(p_rewrites), 0) < 1 then
      raise exception 'a ready scorecard needs at least one rewrite' using errcode = 'check_violation';
    end if;

    -- The quote is the stored question itself; a seq with no turn yields NULL and fails NOT NULL.
    insert into public.scorecard_flags (session_id, seq, label, quote, explanation)
    select p_session,
           (f ->> 'seq')::integer,
           f ->> 'label',
           (select t.question from public.rehearsal_turns t
             where t.session_id = p_session and t.seq = (f ->> 'seq')::integer),
           f ->> 'explanation'
    from jsonb_array_elements(coalesce(p_flags, '[]'::jsonb)) as f;

    insert into public.scorecard_rewrites (session_id, seq, original, suggestion)
    select p_session,
           (r ->> 'seq')::integer,
           (select t.question from public.rehearsal_turns t
             where t.session_id = p_session and t.seq = (r ->> 'seq')::integer),
           r ->> 'suggestion'
    from jsonb_array_elements(p_rewrites) as r;
  end if;

  select count(*) into v_scored from public.rehearsal_turns where session_id = p_session;
  select count(distinct seq) into v_flagged from public.scorecard_flags where session_id = p_session;

  update public.scorecards
  set status = p_status,
      summary = case when p_status = 'ready' then p_summary else null end,
      model = p_model,
      error_kind = case when p_status = 'failed' then p_error_kind else null end,
      turns_scored = case when p_status = 'failed' then 0 else v_scored end,
      turns_flagged = case when p_status = 'ready' then v_flagged else 0 end,
      scoring_started_at = null,
      updated_at = now()
  where session_id = p_session;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.claim_scorecard(uuid) from public, anon, authenticated;
revoke all on function public.store_scorecard(uuid, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.claim_scorecard(uuid) to service_role;
grant execute on function public.store_scorecard(uuid, text, text, text, text, jsonb, jsonb) to service_role;
