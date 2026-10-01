-- S-02 ai-drafted-canvas-from-brief: the founder's one project and its Business Model Canvas claims.
-- FR-005: exactly one project per founder (unique workspace_id = the cap, enforced by the database).
-- FR-006: AI-authored claims are persisted with origin = 'ai_draft' so the UI can mark them distinctly.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table public.projects (
  id               uuid primary key default gen_random_uuid(),
  -- unique = one project per workspace (and a workspace is one per founder) in this release.
  workspace_id     uuid not null unique references public.workspaces (id) on delete cascade,
  brief            text not null check (char_length(brief) between 20 and 2000),
  -- In-flight lease for the AI draft: set while a draft request runs, cleared on completion or failure.
  -- A lease older than 60 seconds is treated as abandoned (a worker died mid-draft).
  draft_started_at timestamptz,
  created_at       timestamptz not null default now()
);

create table public.canvas_claims (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  block      text not null check (block in (
               'key_partners', 'key_activities', 'key_resources', 'value_propositions',
               'customer_relationships', 'channels', 'customer_segments', 'cost_structure', 'revenue_streams'
             )),
  position   integer not null check (position >= 0),
  text       text not null check (char_length(text) between 1 and 280),
  origin     text not null check (origin in ('ai_draft', 'founder')),
  -- Optimistic-concurrency counter, bumped by S-03 on edit. Unused in S-02.
  revision   integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  unique (project_id, block, position)
);

alter table public.projects enable row level security;
alter table public.canvas_claims enable row level security;

-- Defence in depth: anon never touches tenant tables (and there are no anon policies either).
revoke all on public.projects, public.canvas_claims from anon;

-- ---------------------------------------------------------------------------------------------
-- Membership through the parent project. SECURITY DEFINER so child-table policies do not depend on
-- the caller's direct read access to `projects`; search_path is pinned and names are qualified.
-- Reused by later slices (assumptions, rehearsal) for every table that hangs off a project.
-- ---------------------------------------------------------------------------------------------
create function public.is_project_member(project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.projects p
    join public.workspace_members m on m.workspace_id = p.workspace_id
    where p.id = project
      and m.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_project_member(uuid) from public, anon;
grant execute on function public.is_project_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Draft lease: one atomic statement that takes the lease if it is free or stale (older than 60 s) and
-- reports whether this caller got it. SECURITY INVOKER on purpose: the UPDATE runs under the caller's RLS,
-- so a founder can only ever lease their own project. Uses the database clock, so Worker clock skew is
-- irrelevant. Released by setting draft_started_at back to null.
-- ---------------------------------------------------------------------------------------------
create function public.claim_draft_lease(project uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.projects
  set draft_started_at = now()
  where id = project
    and (draft_started_at is null or draft_started_at < now() - interval '60 seconds');
  return found;
end;
$$;

revoke all on function public.claim_draft_lease(uuid) from public, anon;
grant execute on function public.claim_draft_lease(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- RLS: one policy per operation, authenticated only. No DELETE policies (nothing is deleted in this
-- release) and no claim UPDATE policy yet (S-03 adds it together with revision enforcement).
-- ---------------------------------------------------------------------------------------------
create policy "projects_select_member" on public.projects
  for select to authenticated
  using ((select public.is_workspace_member(workspace_id)));

create policy "projects_insert_member" on public.projects
  for insert to authenticated
  with check ((select public.is_workspace_member(workspace_id)));

create policy "projects_update_member" on public.projects
  for update to authenticated
  using ((select public.is_workspace_member(workspace_id)))
  with check ((select public.is_workspace_member(workspace_id)));

create policy "canvas_claims_select_member" on public.canvas_claims
  for select to authenticated
  using ((select public.is_project_member(project_id)));

create policy "canvas_claims_insert_member" on public.canvas_claims
  for insert to authenticated
  with check ((select public.is_project_member(project_id)));
