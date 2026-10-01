-- F-01 data-workspace-scaffold
-- Tenant boundary for the whole product: one personal workspace + one owner membership per founder,
-- created atomically inside the signup transaction (FR-004). No app-side creation, so there is never a
-- signed-up founder without a workspace.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- Single role in this release (PRD: owner only, no teams). Widen the check when teams ship.
  role         text not null default 'owner' check (role = 'owner'),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- A founder has at most one membership (one personal workspace) in this release.
create unique index workspace_members_user_id_key on public.workspace_members (user_id);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

-- Defence in depth: the anon role never touches tenant tables (there are no anon policies either).
revoke all on public.workspaces, public.workspace_members from anon;

-- ---------------------------------------------------------------------------------------------
-- Membership predicate shared by every later slice's RLS policies.
-- SECURITY DEFINER so policies on workspace_members can call it without recursing into themselves.
-- ---------------------------------------------------------------------------------------------
create function public.is_workspace_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- RLS: one policy per operation, authenticated only.
-- No client INSERT/DELETE policies: rows are created by the signup trigger and removed by cascade
-- from auth.users.
-- ---------------------------------------------------------------------------------------------
create policy "workspaces_select_member" on public.workspaces
  for select to authenticated
  using ((select public.is_workspace_member(id)));

create policy "workspaces_update_member" on public.workspaces
  for update to authenticated
  using ((select public.is_workspace_member(id)))
  with check ((select public.is_workspace_member(id)));

create policy "workspace_members_select_member" on public.workspace_members
  for select to authenticated
  using ((select public.is_workspace_member(workspace_id)));

-- ---------------------------------------------------------------------------------------------
-- Signup trigger: workspace + owner membership in the same transaction as the auth.users insert.
-- A failure here fails the signup, so keep it trivial and exception-free on normal input.
-- ---------------------------------------------------------------------------------------------
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_workspace_id uuid;
begin
  insert into public.workspaces (name)
  values ('Personal workspace')
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
