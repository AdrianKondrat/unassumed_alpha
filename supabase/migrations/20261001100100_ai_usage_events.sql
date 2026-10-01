-- F-02 ai-provider-integration: append-only ledger of successful AI calls.
-- Recorded now so accounting stays consistent when billing ships (PRD non-goal: no enforcement yet).
-- Keyed on the founder (auth.users.id), not the workspace, so it has no dependency on tenant tables.
create table public.ai_usage_events (
  id                uuid primary key default gen_random_uuid(),
  founder_id        uuid not null references auth.users (id) on delete cascade,
  task_kind         text not null check (task_kind in ('draft', 'suggest', 'converse', 'score')),
  model             text not null check (char_length(model) between 1 and 200),
  prompt_tokens     integer not null check (prompt_tokens >= 0),
  completion_tokens integer not null check (completion_tokens >= 0),
  total_tokens      integer not null check (total_tokens >= 0),
  created_at        timestamptz not null default now()
);

create index ai_usage_events_founder_created_idx on public.ai_usage_events (founder_id, created_at desc);

alter table public.ai_usage_events enable row level security;
revoke all on public.ai_usage_events from anon;

-- Append-only: a founder can read and insert their own rows; there are no update/delete policies.
create policy "ai_usage_events_select_own" on public.ai_usage_events
  for select to authenticated
  using (founder_id = (select auth.uid()));

create policy "ai_usage_events_insert_own" on public.ai_usage_events
  for insert to authenticated
  with check (founder_id = (select auth.uid()));
