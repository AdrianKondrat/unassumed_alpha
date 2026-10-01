-- S-03 manual-canvas-editing-with-conflict-safety (FR-007, FR-008): founders edit, add and delete canvas claims
-- by hand. Every claim carries a `revision`; a save is a revision-checked write, so two edits racing from the same
-- saved revision give one accepted update and one conflict instead of silent loss.
--
-- The rules live in the database (a BEFORE UPDATE trigger and a function), not only in the routes, because the
-- anon key is public and a founder can call PostgREST directly with their own session.

-- ---------------------------------------------------------------------------------------------
-- Update / delete policies (S-02 deliberately shipped SELECT and INSERT only).
-- ---------------------------------------------------------------------------------------------
create policy "canvas_claims_update_member" on public.canvas_claims
  for update to authenticated
  using ((select public.is_project_member(project_id)))
  with check ((select public.is_project_member(project_id)));

create policy "canvas_claims_delete_member" on public.canvas_claims
  for delete to authenticated
  using ((select public.is_project_member(project_id)));

-- ---------------------------------------------------------------------------------------------
-- Update guard. Whoever writes (the routes, PostgREST directly), a claim:
--   * keeps its place: id, project, block, position and created_at never change;
--   * bumps `revision` by exactly one when its text changes (a caller cannot skip or choose the number);
--   * becomes founder-authored when its text changes (a manual edit is the founder's wording), and its origin
--     can never be flipped any other way;
--   * is left completely untouched by a save that changes nothing (no revision bump, same origin).
-- ---------------------------------------------------------------------------------------------
create function public.canvas_claims_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id
     or new.project_id <> old.project_id
     or new.block <> old.block
     or new.position <> old.position
     or new.created_at <> old.created_at then
    raise exception 'a claim cannot be moved or reassigned' using errcode = 'check_violation';
  end if;

  if new.text is not distinct from old.text then
    new.revision := old.revision;
    new.origin := old.origin;
  else
    new.revision := old.revision + 1;
    new.origin := 'founder';
  end if;
  return new;
end;
$$;

create trigger canvas_claims_guard
  before update on public.canvas_claims
  for each row execute function public.canvas_claims_guard();

-- ---------------------------------------------------------------------------------------------
-- Adding a claim: next free position in the block, computed atomically (a per-block advisory lock makes two
-- parallel adds take consecutive positions instead of colliding on unique (project_id, block, position)), with a
-- per-block cap. SECURITY INVOKER: the insert runs under the caller's RLS, so a founder can only ever add to their
-- own project. Returns {ok: true, claim: {...}} or {ok: false, code: 'block_full'}.
-- ---------------------------------------------------------------------------------------------
create function public.add_canvas_claim(p_project uuid, p_block text, p_text text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Mirrors BLOCK_CLAIM_CAP in src/lib/services/canvas-edit.ts.
  c_cap  constant integer := 12;
  v_next integer;
  v_n    integer;
  v_row  public.canvas_claims;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project::text || ':' || p_block, 0));

  select coalesce(max(position), -1) + 1, count(*) into v_next, v_n
  from public.canvas_claims where project_id = p_project and block = p_block;
  if v_n >= c_cap then return jsonb_build_object('ok', false, 'code', 'block_full'); end if;

  insert into public.canvas_claims (project_id, block, position, text, origin)
  values (p_project, p_block, v_next, p_text, 'founder')
  returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'claim', jsonb_build_object(
      'id', v_row.id, 'block', v_row.block, 'position', v_row.position,
      'text', v_row.text, 'origin', v_row.origin, 'revision', v_row.revision
    )
  );
end;
$$;

revoke all on function public.add_canvas_claim(uuid, text, text) from public, anon;
grant execute on function public.add_canvas_claim(uuid, text, text) to authenticated;
