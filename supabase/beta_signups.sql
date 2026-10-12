-- Private-beta signups collected by the landing page Worker (POST /api/waitlist).
-- The Worker writes with the service-role key, so RLS is on with NO policies:
-- the anon/authenticated keys can neither read nor write this table.
create table if not exists public.beta_signups (
  id               uuid primary key default gen_random_uuid(),
  email            text not null,
  email_normalised text not null,
  source           text not null,
  country          text,
  user_agent       text,
  created_at       timestamptz not null default now(),
  notified_at      timestamptz,
  confirmed_at     timestamptz,
  unsubscribed_at  timestamptz
);

create unique index if not exists beta_signups_email_normalised_key
  on public.beta_signups (email_normalised);

alter table public.beta_signups enable row level security;

revoke all on public.beta_signups from anon, authenticated;
grant all on public.beta_signups to service_role;
