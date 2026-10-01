-- S-04 assumption-suggestion-and-lifecycle: AI-suggested candidates, the founder's accept/edit/reject gate
-- (FR-009, FR-010) and the manual lifecycle status (FR-011).
--
-- One table holds both pending candidates and durable assumptions, told apart by `status`:
--   suggested -> active | rejected          (the review gate; the founder decides, the AI only proposes)
--   active | superseded | retired           (durable lifecycle; any direction among the three)
-- `rejected` is terminal. The app enforces these rules with conditional updates, and the trigger below
-- enforces them again so a client talking to the API directly cannot bypass the gate.

alter table public.projects add column suggest_started_at timestamptz;

-- ---------------------------------------------------------------------------------------------
-- Suggest lease: same shape as claim_draft_lease (S-02). Atomic, DB clock, 60 s staleness, runs under
-- the caller's RLS. Released by setting suggest_started_at back to null.
-- ---------------------------------------------------------------------------------------------
create function public.claim_suggest_lease(project uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.projects
  set suggest_started_at = now()
  where id = project
    and (suggest_started_at is null or suggest_started_at < now() - interval '60 seconds');
  return found;
end;
$$;

revoke all on function public.claim_suggest_lease(uuid) from public, anon;
grant execute on function public.claim_suggest_lease(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table public.assumptions (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  statement  text not null check (char_length(statement) between 1 and 280),
  risk_note  text check (risk_note is null or char_length(risk_note) between 1 and 280),
  status     text not null default 'suggested'
             check (status in ('suggested', 'rejected', 'active', 'superseded', 'retired')),
  -- Single-value check so a future founder-authored origin is a one-line migration.
  origin     text not null default 'ai_suggested' check (origin in ('ai_suggested')),
  -- True when the founder changed the AI's wording while accepting.
  edited     boolean not null default false,
  -- clock_timestamp(), not now(): rows of one batch are inserted in a single transaction and must keep the
  -- AI's riskiest-first order when sorted by created_at.
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index assumptions_project_status_idx on public.assumptions (project_id, status);

-- Which canvas claims a suggestion was derived from (provenance shown on the review card).
create table public.assumption_claims (
  assumption_id uuid not null references public.assumptions (id) on delete cascade,
  claim_id      uuid not null references public.canvas_claims (id) on delete cascade,
  primary key (assumption_id, claim_id)
);

alter table public.assumptions enable row level security;
alter table public.assumption_claims enable row level security;
revoke all on public.assumptions, public.assumption_claims from anon;

-- ---------------------------------------------------------------------------------------------
-- Membership through the parent assumption (for the link table's policies).
-- ---------------------------------------------------------------------------------------------
create function public.is_assumption_member(assumption uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.assumptions a
    join public.projects p on p.id = a.project_id
    join public.workspace_members m on m.workspace_id = p.workspace_id
    where a.id = assumption
      and m.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_assumption_member(uuid) from public, anon;
grant execute on function public.is_assumption_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- RLS: one policy per operation, authenticated only. No DELETE policies: rejection is a status.
-- ---------------------------------------------------------------------------------------------
create policy "assumptions_select_member" on public.assumptions
  for select to authenticated
  using ((select public.is_project_member(project_id)));

-- Clients can only create pending candidates; promotion to `active` happens through an UPDATE, which the
-- trigger below restricts to the review transition.
create policy "assumptions_insert_member_suggested" on public.assumptions
  for insert to authenticated
  with check ((select public.is_project_member(project_id)) and status = 'suggested' and edited = false);

create policy "assumptions_update_member" on public.assumptions
  for update to authenticated
  using ((select public.is_project_member(project_id)))
  with check ((select public.is_project_member(project_id)));

create policy "assumption_claims_select_member" on public.assumption_claims
  for select to authenticated
  using ((select public.is_assumption_member(assumption_id)));

-- The linked claim must belong to the same project as the assumption. Policy subqueries run under the
-- caller's RLS, so a claim id from another founder's project is invisible here and the insert is refused.
create policy "assumption_claims_insert_member" on public.assumption_claims
  for insert to authenticated
  with check (
    (select public.is_assumption_member(assumption_id))
    and exists (
      select 1
      from public.assumptions a
      join public.canvas_claims c on c.project_id = a.project_id
      where a.id = assumption_claims.assumption_id
        and c.id = assumption_claims.claim_id
    )
  );

-- ---------------------------------------------------------------------------------------------
-- Update guard: bumps updated_at and enforces the lifecycle rules for every writer.
-- ---------------------------------------------------------------------------------------------
create function public.assumptions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();

  if new.project_id <> old.project_id or new.origin <> old.origin then
    raise exception 'assumption project and origin are immutable' using errcode = 'check_violation';
  end if;

  if old.status = 'suggested' then
    if new.status not in ('suggested', 'active', 'rejected') then
      raise exception 'a pending suggestion can only be accepted or rejected' using errcode = 'check_violation';
    end if;
  elsif old.status = 'rejected' then
    if new.status <> 'rejected' then
      raise exception 'a rejected suggestion cannot be reopened' using errcode = 'check_violation';
    end if;
  elsif new.status not in ('active', 'superseded', 'retired') then
    raise exception 'a durable assumption can only be active, superseded or retired' using errcode = 'check_violation';
  end if;

  -- Wording (and the `edited` flag) can only change while the suggestion is still pending review.
  if old.status <> 'suggested'
     and (new.statement <> old.statement
          or new.risk_note is distinct from old.risk_note
          or new.edited <> old.edited) then
    raise exception 'an assumption can only be edited while it is being reviewed' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger assumptions_guard_before_update
  before update on public.assumptions
  for each row execute function public.assumptions_guard();

-- ---------------------------------------------------------------------------------------------
-- Atomic batch insert: assumptions and their provenance links land together or not at all.
-- items = [{ "statement": text, "risk_note": text, "claim_ids": [uuid, ...] }, ...]
-- SECURITY INVOKER: every insert is subject to the policies above.
-- ---------------------------------------------------------------------------------------------
create function public.create_suggested_assumptions(project uuid, items jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item   jsonb;
  new_id uuid;
  cid    text;
  n      integer := 0;
begin
  for item in select * from jsonb_array_elements(items) loop
    insert into public.assumptions (project_id, statement, risk_note)
    values (project, item ->> 'statement', item ->> 'risk_note')
    returning id into new_id;

    for cid in select jsonb_array_elements_text(item -> 'claim_ids') loop
      insert into public.assumption_claims (assumption_id, claim_id)
      values (new_id, cid::uuid)
      on conflict do nothing;
    end loop;

    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.create_suggested_assumptions(uuid, jsonb) from public, anon;
grant execute on function public.create_suggested_assumptions(uuid, jsonb) to authenticated;
