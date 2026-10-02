-- Explicit API privileges.
--
-- Until now the schema relied on Supabase's *default privileges* (new public tables are granted to anon,
-- authenticated and service_role) and only revoked what must not exist. That holds on the local CLI stack
-- but is a platform setting on a hosted project: if a project is created with automatic Data API exposure
-- of new tables switched off, every founder request fails with "permission denied for table ...".
--
-- This migration makes the privileges the app needs explicit and least-privilege: exactly the operations the
-- RLS policies allow, nothing more. It only GRANTs, so it is a no-op wherever the defaults already apply.
-- RLS stays the real gate: a privilege without a matching policy still returns zero rows.
--
-- Tables created by later migrations must add their own explicit grants in the same migration.

grant usage on schema public to anon, authenticated, service_role;

-- Tenant boundary (created by the signup trigger; founders can read and rename their workspace).
grant select, update on public.workspaces to authenticated;
grant select on public.workspace_members to authenticated;

-- Usage ledger: append-only for the founder's own rows (policies: select + insert).
grant select, insert on public.ai_usage_events to authenticated;

-- Project and canvas.
grant select, insert, update on public.projects to authenticated;
grant select, insert, update, delete on public.canvas_claims to authenticated;

-- Assumptions (review gate and lifecycle are enforced by policies, the assumptions_guard trigger and functions).
grant select, insert, update on public.assumptions to authenticated;
grant select, insert on public.assumption_claims to authenticated;

-- Rehearsal sessions/turns and scorecards: founders SELECT only (granted in their own migrations); all writes
-- go through service-role-only functions. rehearsal_scenarios stays invisible to every client role.

-- service_role is the server-side role that bypasses RLS. Every service-only function is SECURITY INVOKER, so
-- it needs table privileges to do its work (and the app reads the hidden persona scenario directly). This is
-- what Supabase grants it by default; stated explicitly so it does not depend on a project setting.
grant all on
  public.workspaces,
  public.workspace_members,
  public.ai_usage_events,
  public.projects,
  public.canvas_claims,
  public.assumptions,
  public.assumption_claims,
  public.rehearsal_sessions,
  public.rehearsal_turns,
  public.rehearsal_scenarios,
  public.scorecards,
  public.scorecard_flags,
  public.scorecard_rewrites
to service_role;
